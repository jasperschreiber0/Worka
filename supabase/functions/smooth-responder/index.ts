/**
 * estimating-engine — Layer 2 Decision (Backend)
 *
 * WorkA's single, canonical document-to-estimate reasoning pipeline. Runs
 * inside Supabase (no Vercel timeout) so a multi-call reasoning chain can
 * complete in the background. Accepts POST { file_id, job_id, builder_id,
 * sibling_file_ids?, resume? }, returns 202 immediately, and does the work
 * via EdgeRuntime.waitUntil so the caller isn't blocked.
 *
 * This function used to just extract quantities in one shot. It now behaves
 * like a senior estimator reviewing the project before pricing it:
 *
 *   Stage 1 Document Intelligence   — classify every document, detect
 *                                      duplicates/superseded revisions
 *   Stage 2 Project Understanding   — build an evidence-backed fact base
 *   (Stages 1+2 share one Claude call — the model reads every document once)
 *   Stage 3 Scope Reasoning         — per-trade included/excluded scope
 *   Stage 4 Gap Detection           — what's missing that materially matters
 *   (Stages 3+4 share one Claude call — gap detection falls directly out of
 *   scope reasoning)
 *   Stage 5 Clarifying Questions    — if a BLOCKING gap exists, stop here.
 *                                      No quote is generated until answered.
 *   Stage 6 Estimate Generation     — line items with evidence + confidence
 *
 * Quantities only — pricing (the 5-tier rate hierarchy) and Stage 8 Quality
 * Assurance run Next.js-side afterwards (lib/pricing.ts, lib/estimating/qa.ts)
 * once the quote exists. That split is deliberate, not a shortcut: rate
 * resolution needs the builder's learned/preference/supplier rates, which
 * live in the same Postgres database the Next.js app already talks to.
 *
 * Progress is written to files.intake_stage / intake_pct at each real stage
 * boundary — no cosmetic fake-progress timers.
 */

import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.24.0'
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  splitIntoBatches, mergeFacts, selectFactsForPrompt, selectFactsBalancedBySource, summarizeFactSelection,
  SEMANTIC_DUPLICATE_THRESHOLD, MAX_FACTS_IN_PROMPT,
  withTimeoutAndRetry, classifyAnthropicError, isBillingHaltClassification, maxConsecutiveOccurrences,
  dedupeRealFileIds, splitBatchForRetry, formatWallClockStallReason,
  formatFactForScopePrompt, mergeScopeReasoningResults,
  shouldSkipStage3Call, planStage3Chunks, STAGE3_PER_CALL_TIMEOUT_MS,
  partitionCompletedJobsForClassification,
  buildConservativeAssumption, capConfidenceForBlockingTrade, conservativeAssumptionAppliesToTrade,
  type BatchableFile, type FactRow, type AnthropicFailureClassification,
  type ScopeReasoningResult, type MergedScopeReasoningResult, type Stage3FailureHistory,
  type ConservativeAssumption,
} from './pipeline-logic.ts'
import { guardedClaudeCall, hashAiInput } from './ai-gateway.ts'
import { extractPdfTextGated, hasUsableText, isTextDense, buildTextOnlyBlock, buildTextLayerBlock } from './pdf-text.ts'
import { getPdfPageCount, splitPdfIntoChunks } from './pdf-chunk.ts'

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

// ─── Canonical trade taxonomy ─────────────────────────────────────────────────
// MUST stay byte-for-byte identical to lib/trade-taxonomy.ts and the DB-locked
// trade_categories table (migration 001). This is the one taxonomy WorkA uses
// end to end — see CLAUDE.md "13 trade categories are immutable."

const TRADE_CATEGORIES = [
  { id: 1, name: 'Site Works & Concrete' },
  { id: 2, name: 'Framing' },
  { id: 3, name: 'Roofing' },
  { id: 4, name: 'External Cladding' },
  { id: 5, name: 'Insulation' },
  { id: 6, name: 'Internal Linings' },
  { id: 7, name: 'Fit-out Carpentry' },
  { id: 8, name: 'Cabinetry' },
  { id: 9, name: 'Paint' },
  { id: 10, name: 'Flooring' },
  { id: 11, name: 'Fixtures & Tapware' },
  { id: 12, name: 'Electrical' },
  { id: 13, name: 'Preliminaries' },
]

// ─── Progress stages ──────────────────────────────────────────────────────────

const STAGES: Record<string, number> = {
  uploading: 5,
  reading: 12,
  classifying_documents: 25,
  understanding_project: 40,
  reasoning_scope: 55,
  detecting_gaps: 65,
  awaiting_clarification: 70,
  generating_estimate: 85,
  validating: 92,
  building_quote: 97,
  complete: 100,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Base64-encode an ArrayBuffer in chunks. Spreading a whole multi-MB byte
// array into String.fromCharCode(...) overflows the call stack.
function toBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer))
}

// Same chunked encoding as toBase64, but operating directly on a Uint8Array
// — needed for pdf-lib chunk output, whose .buffer isn't guaranteed to
// exactly match the view's own bounds.
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ─── Fact embeddings (P2 — semantic near-duplicate detection at scale) ─────────
// Best-effort throughout: an unset VOYAGE_API_KEY or a failed call just means
// facts fall back to the exact category+key supersession check from
// migration 030 — never fatal to the pipeline. See migration 031.

const VOYAGE_MODEL = 'voyage-3-lite' // 512-dimension embeddings, cheapest tier

async function embedTexts(texts: string[], voyageApiKey: string | undefined): Promise<Array<number[] | null>> {
  if (!voyageApiKey || texts.length === 0) return texts.map(() => null)
  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${voyageApiKey}` },
      body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: 'document' }),
    })
    if (!res.ok) {
      console.error('Voyage embeddings call failed:', res.status, await res.text().catch(() => ''))
      return texts.map(() => null)
    }
    const body = await res.json() as { data?: Array<{ embedding: number[]; index: number }> }
    const byIndex = new Map((body.data ?? []).map((d) => [d.index, d.embedding]))
    return texts.map((_, i) => byIndex.get(i) ?? null)
  } catch (err) {
    console.error('Voyage embeddings error:', err)
    return texts.map(() => null)
  }
}

// cosineSimilarity, SEMANTIC_DUPLICATE_THRESHOLD, MAX_FACTS_IN_PROMPT, and
// selectFactsForPrompt now live in ./pipeline-logic.ts (imported above) so
// they're unit-testable without a Deno runtime AND so chat's project-memory
// context (lib/project-context.ts, Next.js side) reuses the exact same
// truncation and semantic-duplicate logic instead of maintaining a second,
// silently-divergent definition of both.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DocBlock = any

interface LoadedFile {
  fileId: string
  filename: string
  // A single document normally sends one content block, but a sparse-text
  // PDF sends its vision block plus a supplementary text-layer block (see
  // pdf-text.ts) — an array here, flattened when building a batch's
  // message content, not a second logical "document".
  block: DocBlock | DocBlock[]
  // Present only for a PDF actually sent as a vision block (not text-only,
  // not CSV, not an image) — lets the oversized-file rescue step below
  // page-chunk it instead of excluding it outright if it alone is too big
  // for any batch.
  rawPdfBytes?: Uint8Array
}

// Supabase meters CPU time per REQUEST (2000ms), not per file — every
// loadFileAsBlock call in one runPipeline invocation draws from the SAME
// budget for its text-extraction attempt. This tracks cumulative spend
// across the whole run so a later file can be gated off once earlier
// files have already used up the self-imposed budget, even if no single
// file looks individually dangerous. See gateTextExtraction in
// pipeline-logic.ts for the incident this exists to prevent a repeat of.
interface ExtractionBudget {
  spentMs: number
}

async function loadFileAsBlock(
  supabase: SupabaseClient,
  fileId: string,
  builderId: string,
  budget: ExtractionBudget
): Promise<LoadedFile | null> {
  const { data: fileRow } = await supabase
    .from('files')
    .select('*')
    .eq('id', fileId)
    .eq('builder_id', builderId)
    .single()
  if (!fileRow) {
    console.error(`loadFileAsBlock: no files row for ${fileId} (builder ${builderId})`)
    return null
  }

  const { data: fileData, error: downloadErr } = await supabase.storage
    .from('plans')
    .download(fileRow.storage_path)
  if (downloadErr || !fileData) {
    console.error(`loadFileAsBlock: storage download failed for ${fileId} (${fileRow.filename}):`, downloadErr?.message ?? 'no data returned')
    return null
  }

  const buffer = await fileData.arrayBuffer()
  const base64 = toBase64(buffer)
  const isPdf = fileRow.file_type === 'pdf'
  const isCsv = fileRow.file_type === 'other' && /\.csv$/i.test(fileRow.filename ?? '')

  let block: DocBlock | DocBlock[]
  let rawPdfBytes: Uint8Array | undefined
  if (isCsv) {
    const text = atob(base64)
    block = { type: 'text', text: `CSV FILE (${fileRow.filename}):\n\`\`\`\n${text.slice(0, 40000)}\n\`\`\`` }
  } else if (isPdf) {
    // Text-dense PDFs (specs, fixture schedules, priced BOQs) are sent as
    // text only — skips vision encoding entirely, the single biggest lever
    // on this pipeline's token cost, since these are exactly the documents
    // that were most often the ones getting silently dropped for size.
    // Sparse-text PDFs (actual drawings) still get the full vision read,
    // with any usable text attached as a numeric-accuracy supplement —
    // this is the same rationale lib/pdf-text.ts has always used for the
    // Next.js-side pipeline, applied here with a Deno-portable extractor.
    //
    // Gated, not a plain extractPdfText call: parsing a PDF is genuine
    // CPU-bound work, metered per REQUEST by Supabase (2000ms/invocation),
    // not per file — see extractPdfTextGated's comment for the incident
    // (a ~290KB file, not a large one) this replaced a byte-size-only gate
    // to actually prevent. Page count is cheap here (pdf-lib doesn't
    // interpret font programs, just the object graph) and is an
    // independent-but-still-weak signal alongside byte size.
    const rawBytes = new Uint8Array(buffer)
    let pageCount: number | null = null
    try {
      pageCount = await getPdfPageCount(rawBytes)
    } catch {
      pageCount = null // best-effort — a failed page-count read never blocks the gate on its own
    }

    console.log(JSON.stringify({
      document: fileRow.filename, status: 'extraction_start',
      byteLength: buffer.byteLength, pageCount, cumulativeSpentMs: budget.spentMs,
    }))
    const { text: extractedText, skippedReason, durationMs } = await extractPdfTextGated(
      base64, buffer.byteLength, pageCount, budget.spentMs
    )
    budget.spentMs += durationMs
    console.log(JSON.stringify({
      document: fileRow.filename, status: skippedReason ? 'extraction_skipped' : 'extraction_complete',
      durationMs, cumulativeSpentMs: budget.spentMs,
      reason: skippedReason ?? undefined, textLength: extractedText.length,
    }))

    if (isTextDense(extractedText)) {
      block = buildTextOnlyBlock(fileRow.filename, extractedText)
      console.log(JSON.stringify({ document: fileRow.filename, status: 'fallback_decision', decision: 'text_only' }))
    } else {
      const visionBlock: DocBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      block = hasUsableText(extractedText) ? [visionBlock, buildTextLayerBlock(extractedText)] : visionBlock
      rawPdfBytes = rawBytes
      console.log(JSON.stringify({
        document: fileRow.filename, status: 'fallback_decision',
        decision: hasUsableText(extractedText) ? 'vision_plus_text_supplement' : 'vision_only',
      }))
    }
  } else {
    block = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } }
  }

  return { fileId, filename: fileRow.filename, block, rawPdfBytes }
}

// document-worker persists extraction output as jsonb on document_processing_jobs
// (blockType/text/hasUsableText/pageCount/durationMs — see that function's
// ExtractionResult type, which this must stay structurally compatible
// with). Never holds raw file bytes: a vision-path document's binary is
// plain I/O to re-fetch here and doesn't need re-isolating the way parsing
// did — only the CPU-bound extraction step needed its own invocation.
interface PersistedExtractionResult {
  blockType: 'text_only' | 'vision_only' | 'image' | 'csv'
  text: string | null
  hasUsableText: boolean
  pageCount: number | null
  durationMs: number
  // Phase 1 deterministic duplicate detection (document-worker/index.ts) —
  // when true, this job's content is a byte-identical re-upload of an
  // earlier file in the same job. loadAllFromExtractionResults excludes it
  // before ever building Claude content, regardless of blockType.
  duplicate?: boolean
  duplicateOfFileId?: string
  contentHash?: string
}

async function loadBlockFromExtractionResult(
  supabase: SupabaseClient,
  documentId: string,
  result: PersistedExtractionResult
): Promise<LoadedFile | null> {
  const { data: fileRow } = await supabase.from('files').select('*').eq('id', documentId).single()
  if (!fileRow) return null

  if (result.blockType === 'text_only') {
    return { fileId: fileRow.id, filename: fileRow.filename, block: buildTextOnlyBlock(fileRow.filename, result.text ?? '') }
  }
  if (result.blockType === 'csv') {
    return { fileId: fileRow.id, filename: fileRow.filename, block: { type: 'text', text: `CSV FILE (${fileRow.filename}):\n\`\`\`\n${result.text ?? ''}\n\`\`\`` } }
  }

  const { data: fileData, error: downloadErr } = await supabase.storage.from('plans').download(fileRow.storage_path)
  if (downloadErr || !fileData) return null
  const buffer = await fileData.arrayBuffer()
  const base64 = toBase64(buffer)

  if (result.blockType === 'image') {
    return { fileId: fileRow.id, filename: fileRow.filename, block: { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } } }
  }

  // vision_only
  const visionBlock: DocBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
  const block = result.hasUsableText && result.text ? [visionBlock, buildTextLayerBlock(result.text)] : visionBlock
  return { fileId: fileRow.id, filename: fileRow.filename, block, rawPdfBytes: new Uint8Array(buffer) }
}

async function loadAllFromExtractionResults(
  supabase: SupabaseClient,
  parentJobId: string,
  failedOut: string[],
  duplicatesOut: string[] = []
): Promise<LoadedFile[]> {
  // .order('document_id') — same load-bearing reason as existingFacts/
  // existingDocs above: this determines the order documents are appended
  // to Stage 1/2's `content` array, which is itself one of
  // guardedClaudeCall's hashed inputParts. An unordered fetch here means
  // an unchanged batch of already-completed document_processing_jobs can
  // still produce a different content order — and therefore a different
  // idempotency hash — on a retry, for the same underlying reason
  // record_stage3_failure's circuit breaker was defeated before the
  // existingFacts fix. R-03 from the architecture audit that preceded
  // Phase 1, same bug class as that fix, different call site.
  const { data: completedJobs } = await supabase
    .from('document_processing_jobs')
    .select('document_id, result')
    .eq('parent_job_id', parentJobId)
    .eq('status', 'completed')
    .order('document_id', { ascending: true })

  // Pure partition (pipeline-logic.ts, unit-tested) decides which
  // completed jobs are exact duplicates before any Storage I/O happens —
  // this is what actually stops a re-uploaded identical file from
  // inflating the fact base/document count: a duplicate's document_id
  // never reaches loadBlockFromExtractionResult below, so it never enters
  // `documents`/`facts` sent to Stage 1/2 at all, Claude never returns a
  // file_index for it, and no project_documents/project_facts row can
  // ever be created for it. Not a failure, so kept out of failedOut
  // (which drives the builder-facing "these weren't processed, retry" list).
  const jobRows = (completedJobs ?? []) as Array<{ document_id: string; result: PersistedExtractionResult }>
  const resultByDocId = new Map(jobRows.map((j) => [j.document_id, j.result]))
  const { toClassify, duplicates } = partitionCompletedJobsForClassification(jobRows)
  duplicatesOut.push(...duplicates)

  const loaded: LoadedFile[] = []
  for (const documentId of toClassify) {
    const lf = await loadBlockFromExtractionResult(supabase, documentId, resultByDocId.get(documentId)!)
    if (lf) loaded.push(lf)
    else failedOut.push(documentId)
  }

  // A permanently-failed document's job row still exists (status='failed')
  // — surfaced by filename so the builder sees exactly what to re-upload,
  // mirroring how a storage-load failure was already reported before this
  // queue model existed.
  const { data: failedJobs } = await supabase
    .from('document_processing_jobs')
    .select('document_id')
    .eq('parent_job_id', parentJobId)
    .eq('status', 'failed')
  for (const j of (failedJobs ?? []) as Array<{ document_id: string }>) {
    const { data: row } = await supabase.from('files').select('filename').eq('id', j.document_id).single()
    failedOut.push(row?.filename ?? j.document_id)
  }

  return loaded
}

// ─── Tool schemas ──────────────────────────────────────────────────────────────

const DOCUMENT_INTELLIGENCE_TOOL = {
  name: 'analyse_project_documents',
  description: 'Return the document map (Stage 1) and the evidence-backed project fact base (Stage 2).',
  input_schema: {
    type: 'object' as const,
    properties: {
      documents: {
        type: 'array',
        description: 'One entry per document provided, in the same order.',
        items: {
          type: 'object',
          properties: {
            file_index: { type: 'integer' },
            document_type: {
              type: 'string',
              enum: ['architectural_plan', 'structural_drawing', 'engineering_drawing', 'specification', 'joinery_schedule', 'window_door_schedule', 'site_plan', 'elevation', 'section', 'photo', 'email', 'handwritten_note', 'priced_estimate_or_boq', 'other'],
            },
            discipline: { type: 'string', enum: ['architectural', 'structural', 'civil', 'hydraulic', 'electrical', 'mechanical', 'landscape', 'other'] },
            revision: { type: ['string', 'null'] },
            issue_date: { type: ['string', 'null'], description: 'ISO date if shown on the document, else null.' },
            scale: { type: ['string', 'null'] },
            page_count: { type: ['integer', 'null'] },
            drawing_title: { type: ['string', 'null'] },
            readability: { type: 'string', enum: ['clear', 'partial', 'poor'] },
            ocr_quality: { type: 'string', enum: ['good', 'degraded', 'unreadable'] },
            trade_relevance: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 13 } },
            is_duplicate: { type: 'boolean' },
            duplicate_of_file_index: { type: ['integer', 'null'] },
            is_superseded: { type: 'boolean', description: 'True if a later revision of the same drawing is also present in this set.' },
            superseded_by_file_index: { type: ['integer', 'null'] },
            notes: { type: ['string', 'null'] },
          },
          required: ['file_index', 'document_type', 'discipline', 'readability', 'ocr_quality', 'trade_relevance', 'is_duplicate', 'is_superseded'],
        },
      },
      facts: {
        type: 'array',
        description: 'Every concrete, evidence-backed fact about the project. Do NOT include a fact you cannot point to evidence for — leave it out instead.',
        items: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['project_type', 'building_type', 'construction_method', 'storeys', 'rooms', 'wet_areas', 'kitchens', 'laundries', 'external_works', 'structural_system', 'finishes', 'fixtures', 'materials', 'services', 'trades_involved'],
            },
            key: { type: 'string', description: 'Short label, e.g. "floor_area_m2", "roof_type", "ensuite_count".' },
            value: { type: 'string' },
            source_file_index: { type: ['integer', 'null'] },
            page_reference: { type: ['string', 'null'] },
            evidence: { type: 'string', description: 'The specific observation that supports this fact, e.g. a dimension, a note, a schedule row.' },
            confidence: { type: 'integer', minimum: 0, maximum: 100 },
          },
          required: ['category', 'key', 'value', 'evidence', 'confidence'],
        },
      },
    },
    required: ['documents', 'facts'],
  },
}

const SCOPE_REASONING_TOOL = {
  name: 'reason_about_scope',
  description: 'Return per-trade scope reasoning (Stage 3) and any clarifying questions needed before estimating (Stage 4).',
  input_schema: {
    type: 'object' as const,
    properties: {
      scope: {
        type: 'array',
        description: 'Only include trades that are actually relevant to this project.',
        items: {
          type: 'object',
          properties: {
            trade_category_id: { type: 'integer', minimum: 1, maximum: 13 },
            included_scope: { type: 'array', items: { type: 'string' } },
            excluded_scope: { type: 'array', items: { type: 'string' } },
            dependencies: { type: 'array', items: { type: 'string' } },
            assumptions: { type: 'array', items: { type: 'string' } },
            uncertainty_notes: { type: ['string', 'null'] },
            confidence: { type: 'integer', minimum: 0, maximum: 100 },
          },
          required: ['trade_category_id', 'included_scope', 'excluded_scope', 'confidence'],
        },
      },
      clarifying_questions: {
        type: 'array',
        description: 'Only questions that materially change scope or quantities across a trade. Avoid unnecessary questions — most gaps should be handled as per-line assumptions later, not a question here.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            reason: { type: 'string', description: 'Why this materially affects the estimate.' },
            trade_category_id: { type: ['integer', 'null'] },
            blocking: { type: 'boolean', description: 'True only if the estimate cannot proceed responsibly without an answer (e.g. no structural drawings for a double-storey addition).' },
            suggested_assumption: {
              type: ['string', 'null'],
              description: 'Even for a blocking question, the estimate always proceeds using a stated assumption rather than waiting for an answer — if there is a reasonable, industry-standard default for this specific project, state it here (e.g. "single storey, standard strip footing"). Null only if no reasonable default exists at all.',
            },
          },
          required: ['question', 'reason', 'blocking'],
        },
      },
    },
    required: ['scope', 'clarifying_questions'],
  },
}

const ESTIMATE_GENERATION_TOOL = {
  name: 'generate_estimate',
  description: 'Return the full line-item takeoff for the project.',
  input_schema: {
    type: 'object' as const,
    properties: {
      line_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            trade_category_id: { type: 'integer', minimum: 1, maximum: 13 },
            description: { type: 'string' },
            quantity: { type: ['number', 'null'] },
            unit: { type: ['string', 'null'], description: 'Australian units only: m2, lm, m3, each, lot, weeks, hours.' },
            dimensions_string: { type: ['string', 'null'], description: 'e.g. "12.5m x 8.4m" — the measurement this quantity was derived from.' },
            confidence: { type: 'integer', minimum: 0, maximum: 100 },
            pricing_type: { type: 'string', enum: ['measured', 'pc_allowance', 'provisional_sum'] },
            source_ref: { type: ['string', 'null'], description: 'Drawing reference, e.g. "A3.1", "SK-04".' },
            evidence: { type: ['string', 'null'], description: 'What in the source documents supports this quantity.' },
            manual_input_required: { type: 'boolean', description: 'True when the quantity genuinely cannot be derived from anything provided — never guess a number here.' },
            document_rate: { type: ['number', 'null'], description: 'Only set if the source document itself prints a unit COST rate for this line (a priced estimate/BOQ). Exclude margin and GST.' },
            document_total: { type: ['number', 'null'], description: 'Only set if the source document prints a line COST total for this line. Exclude margin and GST.' },
          },
          required: ['trade_category_id', 'description', 'confidence', 'pricing_type', 'manual_input_required'],
        },
      },
    },
    required: ['line_items'],
  },
}

// ─── Claude call wrapper ────────────────────────────────────────────────────────
//
// No Claude call anywhere in this pipeline previously had an explicit
// timeout — a hung upstream connection would block purely on I/O wait,
// which Supabase's CPU-time governor (metered CPU, not wall clock) never
// interrupts, leaving the whole EdgeRuntime.waitUntil background task
// stuck with no external kill to even trigger the existing crash-recovery
// paths (job_intake_locks staleness, the document-worker queue). Every
// call now goes through withTimeoutAndRetry (pipeline-logic.ts):
// AbortController-backed timeout (the signal is passed into the SDK call
// itself so the abort actually cancels the in-flight HTTP request, not
// just gives up locally) plus one bounded retry for transient failures
// (429/5xx/timeout — see isRetryableApiError). timeoutMs is generous
// (150s) because these are large, multi-thousand-token reasoning calls —
// route.ts's own STUCK_TIMEOUT_MS comment records up to ~90s observed for
// a single 60k-token call, so 150s plus one retry still comfortably fits
// inside the SSE poller's 5-minute stuck-timeout window for a single
// stage. A failure that survives the retry propagates up to runPipeline's
// existing try/catch, which already marks the file failed and releases
// the job lock — this wrapper only prevents "stuck," it doesn't change
// what a genuine failure does downstream.
// Gateway context threaded from runPipeline into every stage's Claude call —
// carries what the shared AI gateway (ai-gateway.ts) needs for spend limits,
// the usage ledger, and idempotent reuse. stage doubles as both the ledger's
// call_site label and (with jobId) the idempotency scope, so a retry of the
// same stage with a byte-identical prompt reuses the stored result instead of
// paying for the call again — the Phase 0 duplicate-work protection.
interface StageGatewayCtx {
  supabase: SupabaseClient
  builderId: string
  jobId: string
  stage: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callTool(
  anthropic: Anthropic,
  gw: StageGatewayCtx,
  system: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: any,
  maxTokens: number,
  // Override for stages whose call shape genuinely needs more room than the
  // 150s default — currently only Scope Reasoning (see its call site). Unlike
  // Stage 1/2, that stage has no per-file "shrink and retry smaller" lever
  // (it reasons over the whole accumulated fact base in one call, not a
  // batch of files), so on a fact-heavy project the identical-payload retry
  // that follows a timeout is guaranteed to hit the same wall again — a
  // wider ceiling is the only lever that can actually help. Still well
  // inside Supabase's real 400s isolate wall-clock limit.
  timeoutMs = 150_000
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const startedAt = Date.now()

  // TEMPORARY DIAGNOSTIC LOGGING — investigating a Stage 3 (Scope Reasoning)
  // 400 invalid_request_error on a real production upload. Added here, in
  // the one shared call site every stage uses, rather than duplicated per
  // stage, so the next failure (any stage) captures the same fields without
  // guessing which stage will fail next. Purely additive — no request
  // parameter below is changed by this logging.
  const textBlocks = content.filter((b) => b && b.type === 'text') as Array<{ text: string }>
  const nonTextBlockTypes = content.filter((b) => b && b.type !== 'text').map((b) => b.type)
  const userContentChars = textBlocks.reduce((sum, b) => sum + (b.text?.length ?? 0), 0)
  const systemChars = system.length
  // Rough, explicitly-approximate estimate (chars/4 is a common English-text
  // heuristic) — good enough to distinguish "obviously fine" from "possibly
  // near a limit" without adding a tokenizer dependency for temporary logging.
  const approxInputTokens = Math.ceil((systemChars + userContentChars) / 4)
  console.log(JSON.stringify({
    event: 'claude_call_request', tool: tool.name, model: 'claude-sonnet-4-6',
    max_tokens: maxTokens, tool_choice: tool.name,
    system_chars: systemChars, user_text_chars: userContentChars,
    non_text_block_types: nonTextBlockTypes, non_text_block_count: nonTextBlockTypes.length,
    approx_input_tokens: approxInputTokens,
    tool_schema: tool.input_schema,
  }))

  // Routed through the shared AI gateway (ai-gateway.ts): budget/breaker
  // check before the call (fails closed — an over-limit run stops with a
  // clear reason and zero spend), idempotent reuse of a prior identical
  // stage call (scope_key = job:stage + prompt hash), and the ai_operations/
  // ai_spend_daily usage ledger. Retry/timeout semantics are unchanged —
  // the gateway wraps the exact same withTimeoutAndRetry this call used
  // directly before.
  const { response, reusedFromOperation } = await guardedClaudeCall(
    {
      supabase: gw.supabase,
      attribution: { kind: 'builder', builderId: gw.builderId },
      callSite: gw.stage,
      model: 'claude-sonnet-4-6',
      scopeKey: `${gw.jobId}:${gw.stage}`,
      inputParts: [system, content, tool.name, maxTokens],
    },
    (signal) => anthropic.messages.create(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content }],
      },
      { signal }
    ),
    {
      timeoutMs,
      maxRetries: 1,
      label: tool.name,
      onAttemptFailed: (info) => {
        // TEMPORARY DIAGNOSTIC LOGGING — capture the Anthropic SDK error's
        // own structured fields (status + parsed error body), not just
        // `.message`. The SDK's APIError already puts the full JSON body
        // into `.message` as text (that's what's been landing in
        // files.failure_reason, truncated to 500 chars there) — logging
        // `.status`/`.error` explicitly here means the next failure doesn't
        // depend on that 500-char cap or on re-parsing a string to find out
        // which field Anthropic actually rejected.
        const err = info.error as { status?: number; error?: unknown; message?: string } | undefined
        console.log(JSON.stringify({
          event: 'claude_call_attempt_failed', tool: tool.name, attempt: info.attempt,
          duration_ms: info.durationMs, retryable: info.retryable,
          classification: info.classification,
          anthropic_status: err?.status ?? null,
          anthropic_error_body: err?.error ?? null,
          error: info.error instanceof Error ? info.error.message : String(info.error),
        }))
      },
    }
  )
  console.log(JSON.stringify({
    event: 'claude_call_complete', tool: tool.name, stop_reason: response.stop_reason,
    usage: response.usage, duration_ms: Date.now() - startedAt,
    reused_from_operation: reusedFromOperation,
  }))
  if (response.stop_reason === 'max_tokens') {
    // A truncated tool call means partial/malformed input (e.g. an empty
    // array where the model just hadn't reached that field yet) rather than
    // a genuine "nothing found" result — fail loudly here instead of letting
    // corrupted data flow downstream as if it were complete.
    throw new Error(`Response truncated at max_tokens=${maxTokens} — increase the token budget for this stage`)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const block = response.content.find((b: any) => b.type === 'tool_use' && b.name === tool.name)
  return block?.input ?? null
}

// ─── Validation gates (mirrors lib/estimating/gates.ts — Deno cannot import
// the Next.js module directly, so this copy must stay semantically identical) ──

interface GateableItem {
  description: string
  quantity: number | null
  unit: string | null
  dimensions_string: string | null
  pricing_type: string
  has_document_price: boolean
  manual_input_required: boolean
}

function applyValidationGates(item: GateableItem): {
  gate: 1 | 2 | 3 | null
  is_assumption: boolean
  assumption_status: 'unresolved' | 'excluded' | null
  message: string | null
} {
  const exempt = item.pricing_type === 'pc_allowance' || item.pricing_type === 'provisional_sum' || item.has_document_price

  if (item.manual_input_required || (!item.unit && !exempt)) {
    return {
      gate: 1,
      is_assumption: true,
      assumption_status: 'unresolved',
      message: item.manual_input_required
        ? `Manual input required — quantity could not be determined from the provided documents for ${item.description}`
        : `Quantity unit not specified — confirm the unit for ${item.description}`,
    }
  }
  if (item.quantity !== null && item.quantity <= 0) {
    return {
      gate: 3,
      is_assumption: true,
      assumption_status: 'excluded',
      message: `Invalid quantity (${item.quantity}) for ${item.description} — excluded from quote`,
    }
  }
  if (item.quantity !== null && !item.dimensions_string && !exempt) {
    return {
      gate: 2,
      is_assumption: true,
      assumption_status: 'unresolved',
      message: `Quantity could not be verified from source documents — confirm ${item.quantity} ${item.unit ?? ''} for ${item.description}`.trim(),
    }
  }
  return { gate: null, is_assumption: false, assumption_status: null, message: null }
}

function deriveDocPrice(rate: unknown, total: unknown, quantity: number | null): { rate: number | null; total: number | null } {
  const r = typeof rate === 'number' && isFinite(rate) && rate > 0 ? rate : null
  const t = typeof total === 'number' && isFinite(total) && total > 0 ? total : null
  if (r === null && t === null) return { rate: null, total: null }
  const qty = quantity !== null && quantity > 0 ? quantity : null
  let derivedTotal = t ?? (r !== null && qty !== null ? round2(r * qty) : r)
  let derivedRate = r ?? (t !== null && qty !== null ? round2(t / qty) : t)
  if (derivedRate === null) derivedRate = derivedTotal
  if (derivedTotal === null) derivedTotal = derivedRate
  return { rate: derivedRate, total: derivedTotal }
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

interface RunArgs {
  fileId: string
  jobId: string
  builderId: string
  siblingFileIds: string[]
  resume: boolean
  // When set, every document to classify was already downloaded and
  // extracted independently by document-worker (its own invocation, its
  // own CPU budget, per document) — Stage 1/2 loads their persisted
  // results (loadAllFromExtractionResults) instead of re-downloading and
  // re-extracting inline. See the "document processing queue" note above
  // loadFileAsBlock for why that isolation exists.
  parentJobId?: string
}

async function runPipeline(args: RunArgs, supabase: SupabaseClient, anthropic: Anthropic) {
  const { fileId, jobId, builderId, siblingFileIds, resume, parentJobId } = args

  // Touches job_intake_locks.last_progress_at alongside the files row on
  // every real stage boundary — lets the Next.js lock-staleness check
  // (app/api/intake/[fileId]/route.ts) reclaim an abandoned lock based on
  // "no progress observed recently" instead of only a fixed, much longer
  // age-since-acquired window. Best-effort: a failed touch here should
  // never block a stage transition from being recorded.
  const touchLockProgress = async () => {
    try {
      await supabase.from('job_intake_locks').update({ last_progress_at: new Date().toISOString() }).eq('job_id', jobId)
    } catch { /* best-effort */ }
  }

  const setStage = async (stage: string) => {
    await supabase.from('files').update({ intake_stage: stage, pipeline_stage: stage, intake_pct: STAGES[stage] ?? 0 }).eq('id', fileId)
    await touchLockProgress()
  }

  const fail = async (reason: string) => {
    await supabase
      .from('files')
      .update({ intake_stage: 'failed', intake_pct: 0, failure_stage: 'AI_REASONING_FAILED', failure_reason: reason.slice(0, 500) })
      .eq('id', fileId)
    if (parentJobId) {
      await supabase.from('document_processing_batches').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', parentJobId)
      // Derives every file in the batch's intake_status from the batch
      // outcome just written (migration 052) — not only fileId (the
      // primary/anchor), so a sibling whose own extraction succeeded but
      // whose run died later (e.g. a billing halt at Stage 3/6) also
      // correctly ends up 'failed', instead of staying frozen at
      // 'uploaded' forever.
      await supabase.rpc('recompute_batch_file_intake_statuses', { p_batch_id: parentJobId })
    } else {
      // Legacy direct-invocation path (no queue model, no batch) — no
      // derivation table to recompute from, so this file is the only one
      // that needs (and can have) an explicit write.
      await supabase.from('files').update({ intake_status: 'failed' }).eq('id', fileId)
    }
  }

  // ── Billing-halt: stop calling Anthropic for the REST of this run ───────
  // credit_exhausted / authentication_failed mean the account itself cannot
  // proceed — every subsequent call in this run (next batch, Stage 3, Stage
  // 6) would fail identically, so continuing to make them was the second
  // half of the incident this was built to close (the first 400
  // credit-balance error was logged, but the pipeline kept spending on
  // batch 2, Stage 3, Stage 6 regardless). Callers MUST `return` immediately
  // after calling this — it does not throw, so the caller controls the
  // unwind. Remaining unprocessed documents/stages are left exactly as they
  // are (still 'pending' at the document-worker layer) rather than marked
  // failed — this is a temporary account-level condition, not a verdict on
  // those documents, so they should resume normally once billing is fixed
  // rather than requiring a full re-upload.
  const haltForBilling = async (classification: AnthropicFailureClassification, reason: string) => {
    console.log(JSON.stringify({ event: 'ai_billing_halt', classification, reason, file_id: fileId, job_id: jobId }))
    await fail(
      `AI processing stopped: ${classification === 'credit_exhausted' ? 'Anthropic account credit balance is too low' : 'Anthropic API authentication failed'} — ${reason}`.slice(0, 500)
    )
  }

  // ── Per-file AI failure history (files.ai_failure_classification / .ai_failure_count, migration 042) ──
  // Persists across invocations so a LATER run (a resume, a fresh upload
  // trigger, a recovery reclaim) doesn't blindly repeat a call that has
  // already proven deterministic for this exact file — the root cause of
  // "the same document batch is later processed again by recovery" in the
  // incident this closes. maxConsecutiveOccurrences (pipeline-logic.ts)
  // decides how many identical occurrences are tolerated per
  // classification before the file is marked permanently failed — 0 for a
  // deterministic-content failure (never worth even one retry), 1 for a
  // deterministic-SIZE failure (one more attempt at a genuinely smaller
  // request is worth it — see forcedSoloInput below), 2 for a classification
  // that's already survived one in-call retry and failed identically again.
  //
  // Delegates the actual read-modify-write to record_ai_failure (migration
  // 043) rather than doing it here in JS: production readiness review
  // finding (blocking issue 3) — a JS-side SELECT-then-UPDATE is not atomic
  // across two overlapping invocations of this same job (reclaiming a
  // stale job_intake_lock does not kill the physical old invocation still
  // running server-side — see acquire_or_reclaim_job_intake_lock's own
  // comment), which could lose an increment and undermine the exact
  // safety cap this exists to provide. The SQL function holds a row lock
  // (SELECT ... FOR UPDATE) for its whole transaction, so concurrent
  // callers are strictly serialized instead of racing.
  const recordAiFailure = async (rawFileId: string, classification: AnthropicFailureClassification, reason: string) => {
    const fid = rawFileId.split('#')[0] // strip pdf-chunk.ts's `${realId}#pStart-End` suffix — one files row per real file
    const { data, error } = await supabase.rpc('record_ai_failure', {
      p_file_id: fid,
      p_classification: classification,
      p_reason: reason,
      p_max_occurrences: maxConsecutiveOccurrences(classification),
    })
    if (error) {
      // Best-effort, matching every other observability write in this
      // pipeline: a failure to RECORD a failure must never itself throw
      // and mask the original error the caller is already handling.
      console.error('record_ai_failure RPC failed:', error)
      return false
    }
    const result = (data as Array<{ classification: string; occurrence_count: number; stopped: boolean }> | null)?.[0]
    console.log(JSON.stringify({
      event: 'ai_failure_recorded', file_id: fid, classification,
      consecutive_count: result?.occurrence_count ?? null, stopped: result?.stopped ?? false,
    }))
    return result?.stopped ?? false
  }

  const startedAt = Date.now()

  // ── Wall-clock safety ceiling ─────────────────────────────────────────
  // Supabase Edge Functions have a real, external isolate wall-clock
  // lifetime (~400s) — separate from the 2000ms CPU-time budget
  // ExtractionBudget guards elsewhere in this pipeline. Confirmed in
  // production: two back-to-back Stage 1/2 batches each hit their own
  // AbortController ceiling (~150s apart), leaving ~300s already spent
  // before Stage 3 ever fired — Stage 3 then fired anyway, and the
  // isolate was killed externally (a bare "shutdown" log, no
  // claude_call_complete/attempt_failed for that call) before its own
  // 220s timeout could ever resolve cleanly. Unlike a clean
  // AbortController timeout, an external platform kill skips this
  // pipeline's try/finally entirely — job_intake_locks leaks until
  // staleness reclaim (minutes), instead of being releasable immediately.
  // Checked before every remaining Claude call in this invocation; if
  // there isn't enough safe room left for one, the run stops itself
  // cleanly instead — nothing is marked permanently failed (this is a
  // scheduling/capacity condition, not a verdict on any file, same
  // philosophy as haltForBilling below), so the lock releases via the
  // existing finally and the very next SSE reconnect can retrigger with a
  // full, fresh wall-clock budget rather than waiting on a platform kill
  // and the slower staleness-based recovery path.
  const WALL_CLOCK_SAFETY_MS = 340_000 // 60s margin under the real ~400s ceiling
  const hasWallClockBudget = (neededMs: number) => (Date.now() - startedAt) + neededMs <= WALL_CLOCK_SAFETY_MS
  // Was: log-only, silent `return` — no terminal state, no persisted reason.
  // That made a wall-clock exit indistinguishable from a healthy in-progress
  // run to everything downstream (the SSE poller, the recovery cron, a human
  // looking at the files/document_processing_batches rows), and gave the
  // recovery cron nothing to check before blindly re-running Stage 3 on
  // every retrigger (see the Stage 3 checkpoint below for the other half of
  // this fix). Now persists stage/reason/timestamp/attempt-count to
  // document_processing_batches (migration 053) — deliberately NOT routed
  // through files.ai_failure_classification/ai_failure_count (migration
  // 042): this is a scheduling condition (ran out of safe room to attempt a
  // call), not a content or model failure, and must not consume the
  // Anthropic-failure retry budget that exists for actually-bad documents.
  const bailForWallClockBudget = async (stage: string, neededMs: number) => {
    const elapsedMs = Date.now() - startedAt
    const reason = formatWallClockStallReason(stage, neededMs, elapsedMs, WALL_CLOCK_SAFETY_MS)
    console.log(JSON.stringify({
      event: 'wall_clock_budget_exhausted', stage, needed_ms: neededMs,
      elapsed_ms: elapsedMs, job_id: jobId, file_id: fileId, parent_job_id: parentJobId ?? null,
    }))
    if (parentJobId) {
      try {
        const { data: current } = await supabase
          .from('document_processing_batches')
          .select('stall_count')
          .eq('id', parentJobId)
          .single()
        await supabase.from('document_processing_batches').update({
          stall_stage: stage,
          stall_reason: reason,
          stalled_at: new Date().toISOString(),
          stall_count: (current?.stall_count ?? 0) + 1,
          updated_at: new Date().toISOString(),
        }).eq('id', parentJobId)
      } catch (err) {
        console.error('Failed to persist wall-clock stall state to document_processing_batches:', err)
      }
    }
    // Also surfaced on the files row directly (both the parentJobId and
    // legacy no-batch paths) — best-effort, non-terminal (intake_status is
    // deliberately left as-is, still recoverable/retryable, not 'failed').
    try {
      await supabase.from('files').update({
        failure_stage: `WALL_CLOCK_STALLED:${stage}`,
        failure_reason: reason.slice(0, 500),
      }).eq('id', fileId)
    } catch (err) {
      console.error('Failed to persist wall-clock stall state to files:', err)
    }
  }

  try {
    await supabase.from('files').update({ intake_status: 'processing' }).eq('id', fileId)
    await setStage('reading')

    // ── Load builder memory context (best-effort, non-fatal) ──────────────
    let memoryContext = ''
    try {
      const { data: memRows } = await supabase
        .from('project_memory')
        .select('project_summary, job_type, floor_area_m2, region, quoted_cost')
        .eq('builder_id', builderId)
        .in('status', ['completed', 'active'])
        .order('completed_at', { ascending: false })
        .limit(10)
      if (memRows && memRows.length > 0) {
        memoryContext = `\n\nHISTORICAL CONTEXT — ${memRows.length} past project(s) from this builder:\n` +
          memRows.map((p: Record<string, unknown>) => `• ${p.project_summary ?? p.job_type ?? 'Project'} (${p.floor_area_m2 ?? '?'}sqm, ${p.region ?? '?'})`).join('\n')
      }
    } catch { /* non-fatal */ }

    // ── Existing state for this job (incremental upload / resume support) ─
    // .order('id') is load-bearing, not cosmetic: without it, Postgres makes
    // no row-order guarantee across separate executions of this same query.
    // stage3InputHash (below) is computed from factsBlock, which is built by
    // joining factsForPrompt in array order — and selectFactsBalancedBySource
    // returns its input UNSORTED whenever facts.length <= MAX_FACTS_IN_PROMPT
    // (the common case), so an unstable query order flows straight into the
    // hash. That silently broke Stage 3's whole "stop repeating an input
    // that's already failed identically" circuit breaker (shouldSkipStage3Call
    // / record_stage3_failure, migration 059): every retry of an UNCHANGED
    // fact base was hashing to something different, so record_stage3_failure
    // saw prior_input_hash !== current hash every time, reset the streak to 1
    // every time, and never reached maxConsecutiveOccurrences — an unbounded,
    // real-spend retrigger loop (recovery_classification_retriggered firing
    // every ~60s for the same batch, stage3_trades_already_completed stuck at
    // 0, resume_kind always fresh_or_unstarted), traced live 2026-07-19/20.
    // Deterministic order makes an unchanged fact base hash identically on
    // every retry, so the breaker actually engages.
    const { data: existingFacts } = await supabase
      .from('project_facts')
      .select('id, category, key, value, evidence, confidence, embedding, source_document_id')
      .eq('job_id', jobId)
      .eq('superseded', false)
      .order('id', { ascending: true })

    // .order('id') for the same reason as existingFacts above: this feeds
    // processedDocTitles -> docSystemPrompt below, which is itself one of
    // Stage 1/2's guardedClaudeCall inputParts (callTool's `system`
    // argument) — an unordered row order here means an unchanged set of
    // already-processed documents can still hash differently across
    // retries, defeating idempotent reuse for the exact same reason
    // record_stage3_failure's circuit breaker was defeated (see that
    // comment). Same bug class, different call site — R-03 from the
    // architecture audit that preceded Phase 1.
    const { data: existingDocs } = await supabase
      .from('project_documents')
      .select('id, file_id, document_type, drawing_title')
      .eq('job_id', jobId)
      .order('id', { ascending: true })

    // Carries id/embedding through the whole run (not just category/key/
    // value/confidence) so batched Stage 1/2 calls below can supersede
    // against facts from earlier batches in this same run, not only
    // against what was already in the database before this run started.
    let facts: FactRow[] =
      (existingFacts ?? []).map((f: Record<string, unknown>) => ({
        id: f.id as string,
        category: f.category as string, key: f.key as string, value: f.value as string,
        evidence: (f.evidence as string) ?? null, confidence: f.confidence as number,
        embedding: (f.embedding as number[] | null) ?? null,
        // Without this, every fact loaded from a PRIOR upload would land in
        // the "no source" group of the balanced selector below — collapsing
        // per-document representation exactly on the incremental uploads
        // where the fact base is biggest and balance matters most.
        source_document_id: (f.source_document_id as string | null) ?? null,
      }))

    // ── Stage 1 + 2: Document Intelligence + Project Understanding ────────
    // Skipped entirely on an answers-only resume — the documents were already
    // classified and their facts already persisted; we're only folding in the
    // builder's new answers (already written as project_facts by the caller).
    const skippedSiblings: string[] = []
    const failedToLoadSiblings: string[] = []
    if (!resume) {
      let allLoaded: LoadedFile[]

      if (parentJobId) {
        // Extraction already happened per-document, each in its own
        // document-worker invocation with its own CPU budget (see that
        // function's header comment) — load the persisted results instead
        // of downloading and re-extracting inline. A document whose job
        // never reached 'completed' (still retrying, or permanently
        // failed) is simply absent from this batch; permanently-failed
        // ones are still surfaced by filename below.
        const skippedDuplicates: string[] = []
        allLoaded = await loadAllFromExtractionResults(supabase, parentJobId, failedToLoadSiblings, skippedDuplicates)
        if (skippedDuplicates.length > 0) {
          console.log(JSON.stringify({
            event: 'stage12_duplicates_excluded', job_id: jobId, parent_job_id: parentJobId,
            duplicate_count: skippedDuplicates.length, duplicate_document_ids: skippedDuplicates,
          }))
        }
        if (allLoaded.length === 0 && skippedDuplicates.length > 0) {
          // Every file in this upload was a byte-identical re-upload of
          // content already classified for this job — not a failure, and
          // nothing about the estimate needs to change: the job's existing
          // quote already reflects this content from when it was first
          // uploaded. Reuse it (no new Stage 3-6 Claude calls, no new
          // quote row) rather than treating an all-duplicates batch as an
          // error.
          const { data: currentQuote } = await supabase
            .from('quotes')
            .select('id')
            .eq('job_id', jobId)
            .eq('is_current', true)
            .maybeSingle()

          if (currentQuote?.id) {
            await supabase.from('files').update({
              intake_stage: 'complete', intake_pct: 100, pipeline_stage: 'complete',
              quote_id: currentQuote.id, failure_stage: null, failure_reason: null,
            }).eq('id', fileId)
            if (parentJobId) {
              await supabase.from('document_processing_batches').update({ quote_id: currentQuote.id, updated_at: new Date().toISOString() }).eq('id', parentJobId)
              await supabase.rpc('recompute_batch_file_intake_statuses', { p_batch_id: parentJobId })
            } else {
              await supabase.from('files').update({ intake_status: 'extracted' }).eq('id', fileId)
            }
            console.log(JSON.stringify({
              event: 'all_documents_duplicate_reused_existing_quote', job_id: jobId, parent_job_id: parentJobId,
              quote_id: currentQuote.id, duplicate_count: skippedDuplicates.length,
            }))
            return
          }
          // No existing quote to reuse (shouldn't normally happen — a
          // duplicate requires a prior file in this job to already have
          // been classified) — fall through to the genuine-failure path
          // below with a clearer reason.
          await fail('Every document in this batch was already processed, and no existing quote was found to reuse for this job')
          return
        }
        if (allLoaded.length === 0) {
          await fail('No documents were successfully extracted for this batch')
          return
        }
      } else {
        // Legacy direct-load path — kept for any caller that still invokes
        // this function the old way (not through the document processing
        // queue). Shared across every loadFileAsBlock call in this run —
        // see ExtractionBudget's comment above.
        const extractionBudget: ExtractionBudget = { spentMs: 0 }

        const primary = await loadFileAsBlock(supabase, fileId, builderId, extractionBudget)
        if (!primary) { await fail('File record or storage object not found'); return }

        // Sane upper bound on how many documents one run will even attempt —
        // batching below means a run is no longer capped at ~7 files, but an
        // unbounded upload could still mean unbounded Storage downloads and
        // Claude calls in one invocation. Anything beyond this is tracked as
        // skipped (with a real filename looked up), never silently ignored —
        // previously anything past the first 6 sibling files wasn't even
        // loaded or tracked, it just vanished.
        const MAX_SIBLINGS_CONSIDERED = 30
        const consideredSiblingIds = siblingFileIds.slice(0, MAX_SIBLINGS_CONSIDERED)
        const overflowSiblingIds = siblingFileIds.slice(MAX_SIBLINGS_CONSIDERED)

        const loadedSiblings: LoadedFile[] = []
        for (const sibId of consideredSiblingIds) {
          const loadStartedAt = Date.now()
          const loaded = await loadFileAsBlock(supabase, sibId, builderId, extractionBudget)
          if (loaded) {
            loadedSiblings.push(loaded)
            console.log(JSON.stringify({ document: loaded.filename, status: 'loaded', durationMs: Date.now() - loadStartedAt }))
          } else {
            const { data: row } = await supabase.from('files').select('filename').eq('id', sibId).single()
            const filename = row?.filename ?? sibId
            failedToLoadSiblings.push(filename)
            console.log(JSON.stringify({ document: filename, status: 'failed_to_load', durationMs: Date.now() - loadStartedAt }))
          }
        }
        for (const sibId of overflowSiblingIds) {
          const { data: row } = await supabase.from('files').select('filename').eq('id', sibId).single()
          skippedSiblings.push(row?.filename ?? sibId)
        }

        allLoaded = [primary, ...loadedSiblings]
      }

      // ── Exclude files that have already proven deterministically unprocessable, or that are already durably classified ──
      // Two independent exclusions here, both defensive second checks —
      // the PRIMARY place each is enforced now is a layer up:
      //   - "already exhausted its retries": the authoritative signal is
      //     intake_status='failed' itself — record_ai_failure (migration
      //     043) sets that atomically once maxConsecutiveOccurrences
      //     (pipeline-logic.ts) is reached for this file's classification.
      //   - "already classified": app/api/intake/[fileId]/route.ts now
      //     filters this out before a document_processing_jobs row is even
      //     created (see that route's own comment) — this is a same-run
      //     re-read for whatever slipped through anyway, e.g. the legacy
      //     direct-invocation path (no parentJobId) that doesn't go
      //     through that filtering at all. extraction_status='complete' is
      //     only ever set inside persist_document_classification
      //     (migration 050), atomically with the project_facts it depends
      //     on, so it's safe to trust here. Reclassifying an already-
      //     complete file has nothing to gain and real risk to lose:
      //     re-running Stage 1/2 on an unchanged document can spuriously
      //     supersede a perfectly good fact with a differently-worded (but
      //     not actually different) restatement, since mergeFacts treats
      //     any value mismatch as a real correction — LLM output isn't
      //     guaranteed byte-identical across calls.
      let priorFailureCounts = new Map<string, { classification: AnthropicFailureClassification | null; count: number }>()
      if (allLoaded.length > 0) {
        const uniqueRealIds = Array.from(new Set(allLoaded.map((f) => f.fileId.split('#')[0])))
        const { data: historyRows } = await supabase
          .from('files')
          .select('id, ai_failure_classification, ai_failure_count, intake_status')
          .in('id', uniqueRealIds)
        priorFailureCounts = new Map(
          (historyRows ?? []).map((r: Record<string, unknown>) => [
            r.id as string,
            { classification: (r.ai_failure_classification as AnthropicFailureClassification | null) ?? null, count: (r.ai_failure_count as number) ?? 0 },
          ])
        )
        const alreadyFailed = new Set((historyRows ?? []).filter((r: Record<string, unknown>) => r.intake_status === 'failed').map((r: Record<string, unknown>) => r.id as string))

        const { data: completedDocs } = await supabase
          .from('project_documents')
          .select('file_id')
          .eq('job_id', jobId)
          .eq('extraction_status', 'complete')
          .in('file_id', uniqueRealIds)
        const alreadyComplete = new Set((completedDocs ?? []).map((r: Record<string, unknown>) => r.file_id as string))

        const stillEligible: LoadedFile[] = []
        for (const f of allLoaded) {
          const realId = f.fileId.split('#')[0]
          const history = priorFailureCounts.get(realId)
          if (alreadyFailed.has(realId)) {
            failedToLoadSiblings.push(f.filename)
            console.log(JSON.stringify({ document: f.filename, status: 'skipped_exhausted_retries', prior_classification: history?.classification ?? null, prior_count: history?.count ?? 0 }))
          } else if (alreadyComplete.has(realId)) {
            console.log(JSON.stringify({ document: f.filename, status: 'skipped_already_classified' }))
          } else {
            stillEligible.push(f)
          }
        }
        allLoaded = stillEligible
      }

      // ── Batch instead of a single hard cutoff ────────────────────────────
      // Previously: one 20MB pass/fail per run, largest-first, anything that
      // didn't fit was dropped with no way to retry short of a fresh manual
      // re-upload. Now: up to MAX_BATCHES batches of up to 20MB each, one
      // Stage 1/2 Claude call per batch, facts merged across batches the
      // same way the existing incremental-upload path already merges facts
      // across separate uploads (see mergeFacts in pipeline-logic.ts).
      // MAX_BATCHES bounds this invocation's total wall-clock time, since
      // each batch is a real, possibly-slow Claude call run sequentially —
      // true cross-invocation batching (for uploads that would still exceed
      // even this) is a natural follow-up using the same batch-index
      // persistence below, not implemented in this pass.
      const MAX_BYTES_PER_BATCH = 20 * 1024 * 1024
      const MAX_BATCHES = 3

      // Rescue a single vision PDF too large to fit any batch on its own —
      // splitIntoBatches would otherwise exclude it outright (a whole
      // document lost, not just delayed). Only reached for genuinely large,
      // vision-necessary documents: a text-dense PDF this large would
      // already have been reduced to a small text block above, long before
      // this point. Chunk ids are suffixed (`${realId}#pStart-End`) and
      // mapped back to the real file id wherever a DB row is written below
      // (realFileId) — multiple chunks of one file share that file's single
      // project_documents row; the last chunk processed wins its
      // classification metadata, but every chunk's facts are captured
      // regardless, since facts aren't gated by that row.
      const expandedLoaded: LoadedFile[] = []
      for (const f of allLoaded) {
        const approxBytes = JSON.stringify(f.block).length
        if (approxBytes > MAX_BYTES_PER_BATCH && f.rawPdfBytes) {
          try {
            const pageCount = await getPdfPageCount(f.rawPdfBytes)
            const targetChunks = Math.ceil(approxBytes / MAX_BYTES_PER_BATCH)
            const pagesPerChunk = Math.max(1, Math.floor(pageCount / targetChunks))
            const chunks = await splitPdfIntoChunks(f.rawPdfBytes, pagesPerChunk)
            if (chunks.length > 1) {
              console.log(JSON.stringify({ document: f.filename, status: 'chunked', pageCount, chunkCount: chunks.length }))
              for (const c of chunks) {
                expandedLoaded.push({
                  fileId: `${f.fileId}#p${c.pageStart}-${c.pageEnd}`,
                  filename: `${f.filename} (pages ${c.pageStart}-${c.pageEnd})`,
                  block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytesToBase64(c.bytes) } },
                })
              }
              continue
            }
          } catch (err) {
            console.log(JSON.stringify({ document: f.filename, status: 'chunk_failed', error: err instanceof Error ? err.message : String(err) }))
            // Fall through — keep the original oversized entry below;
            // splitIntoBatches will exclude it with a clear reason rather
            // than this failing the whole run.
          }
        }
        expandedLoaded.push(f)
      }

      const batchInput: BatchableFile[] = expandedLoaded.map((f) => ({
        fileId: f.fileId,
        filename: f.filename,
        approxBytes: JSON.stringify(f.block).length,
      }))

      // ── Never resend an identical request that already timed out ────────
      // A file with exactly one prior AI failure (ai_failure_count === 1 —
      // two would already have been excluded above) is pulled out of the
      // normal bin-packer and forced into its own solo batch: whatever
      // grouping it was bundled with last time is guaranteed not to recur,
      // since a solo request is strictly smaller than any multi-file
      // grouping the packer could have produced. This is what "split the
      // batch, never resend the identical oversized request" means across
      // invocations — a live in-run recursive split isn't needed because
      // the persisted per-file history already tells the NEXT invocation to
      // start smaller. If a solo file still fails, ai_failure_count reaches
      // 2 and recordAiFailure permanently excludes it — no third attempt.
      const forcedSoloInput = batchInput.filter((f) => (priorFailureCounts.get(f.fileId.split('#')[0])?.count ?? 0) >= 1)
      const freshInput = batchInput.filter((f) => (priorFailureCounts.get(f.fileId.split('#')[0])?.count ?? 0) < 1)
      const soloTaken = forcedSoloInput.slice(0, MAX_BATCHES)
      const soloOverflow = forcedSoloInput.slice(MAX_BATCHES)
      const soloBatches: BatchableFile[][] = soloTaken.map((f) => [f])
      const remainingBatchBudget = Math.max(0, MAX_BATCHES - soloBatches.length)
      const { batches: freshBatches, excluded: freshExcluded } = splitIntoBatches(freshInput, MAX_BYTES_PER_BATCH, remainingBatchBudget)
      const fileBatches = [...soloBatches, ...freshBatches]
      const excluded = [
        ...soloOverflow.map((f) => ({ fileId: f.fileId, filename: f.filename, reason: 'previously timed out — retrying alone once batch capacity allows' })),
        ...freshExcluded,
      ]
      for (const ex of excluded) skippedSiblings.push(ex.filename)

      // Persist what's included/excluded as soon as it's decided — not just
      // on eventual success — so a later-stage failure or timeout doesn't
      // discard information the engine already had (previously this was
      // only ever written on the final success path, so a timeout gave the
      // builder zero indication anything had been skipped).
      await supabase.from('files').update({
        skipped_sibling_filenames: skippedSiblings.length > 0 ? skippedSiblings : null,
        failed_sibling_filenames: failedToLoadSiblings.length > 0 ? failedToLoadSiblings : null,
        intake_batch_count: fileBatches.length,
      }).eq('id', fileId)

      const blockById = new Map(expandedLoaded.map((f) => [f.fileId, f]))
      // Chunk ids are `${realId}#pStart-End` — this strips that suffix so
      // every DB write (project_documents.file_id, project_facts.
      // source_document_id) always references the real files row, never a
      // synthetic chunk id that has no row of its own.
      const realFileId = (id: string): string => id.split('#')[0]
      // Titles of documents classified so far — starts with documents from
      // earlier uploads to this job, grows with each batch in this run, so
      // batch 2+ knows what batch 1 already established, not just what the
      // database had before this run started.
      const processedDocTitles: string[] = ((existingDocs ?? []) as Array<Record<string, unknown>>)
        .map((d) => (d.drawing_title as string) ?? (d.document_type as string))
        .filter((t): t is string => Boolean(t))

      for (let batchIdx = 0; batchIdx < fileBatches.length; batchIdx++) {
        const batchFiles = fileBatches[batchIdx]
          .map((bf) => blockById.get(bf.fileId))
          .filter((f): f is LoadedFile => Boolean(f))

        // A solo batch (forced by a prior AI failure — see forcedSoloInput
        // above) gets the wider 220s budget: confirmed in production that a
        // genuinely large/complex document (a full structural drawing set)
        // can still exceed the standard 150s even completely alone, and
        // retrying it identically at the same 150s ceiling is guaranteed to
        // reproduce the identical timeout. A bundled (non-solo) batch stays
        // at 150s — MAX_BATCHES already bounds how many of these one
        // invocation can attempt, and widening every batch risks the same
        // wall-clock exhaustion this budget guard exists to prevent.
        const batchTimeoutMs = batchFiles.length === 1 ? 220_000 : 150_000
        if (!hasWallClockBudget(batchTimeoutMs)) {
          await bailForWallClockBudget('classifying_documents', batchTimeoutMs)
          break
        }

        await supabase.from('files').update({ intake_batch_index: batchIdx + 1 }).eq('id', fileId)
        await touchLockProgress()
        await setStage('classifying_documents')

        // Prior facts, so extraction of a newly-uploaded document isn't blind
        // to what earlier documents/batches already established. This used
        // to be title-only ("you cannot see the old files directly") — Claude
        // extracting from this week's spec document had no way to know
        // floor_area_m2 was already 120 from last week's plan, so it couldn't
        // flag agreement, addition, or contradiction. Superseding a
        // contradicted fact is handled deterministically below at write time
        // (matched by category+key or semantic similarity), not by asking
        // the model to self-report it.
        const priorFactsBlock = facts.length > 0
          ? selectFactsBalancedBySource(facts).map((f) => `- [${f.category}] ${f.key}: ${f.value}`).join('\n')
          : ''

        const existingDocsNote = processedDocTitles.length > 0
          ? `\n\nThis job already has ${processedDocTitles.length} previously-processed document(s): ${processedDocTitles.join(', ')}. You cannot see those earlier files directly (only their titles above), but here is everything already established about this project from them:\n${priorFactsBlock || '(no facts recorded yet)'}\n\nTreat the new document(s) below as an addition to this project, not a fresh start. Extract facts normally from what's in front of you — if something in a new document changes a fact listed above (e.g. a revised drawing changes a room count or floor area), just extract the corrected value; WorkA reconciles the correction automatically, you don't need to flag it separately.`
          : ''

        const docSystemPrompt = `You are a senior document controller and quantity surveyor reviewing construction documents for an Australian residential project. Classify every document precisely and extract only facts you can point to direct evidence for. Never invent a fact — if something is not shown or stated, simply omit it. Unknown must remain unknown.${existingDocsNote}${memoryContext}`

        // A document's block is an array when it has a supplementary text
        // excerpt (a sparse-text PDF's text layer, attached right after its
        // vision block) — flattened here for the API, but each entry in
        // batchFiles is still exactly one logical document for file_index
        // purposes, regardless of how many content blocks it expands to.
        const docUserContent = [
          ...batchFiles.flatMap((f) => Array.isArray(f.block) ? f.block : [f.block]),
          {
            type: 'text',
            text: `Analyse the ${batchFiles.length} document(s) above (file_index 0 to ${batchFiles.length - 1}, in the order provided — a document immediately followed by a text excerpt block is that document's own extracted text layer, not a separate document). Use the analyse_project_documents tool.`,
          },
        ]

        const batchStartedAt = Date.now()
        let docResult: { documents?: unknown[]; facts?: unknown[] } | null = null
        try {
          // Was 4096, then 8192 -- both still truncated on a real DA submission
          // plus supporting documents (confirmed via the stop_reason=max_tokens
          // log added above). Match ESTIMATE_GENERATION_TOOL's already-proven
          // 16000 for this same model/API rather than guessing at another cap.
          docResult = await callTool(anthropic, { supabase, builderId, jobId, stage: 'stage_document_intelligence' }, docSystemPrompt, docUserContent, DOCUMENT_INTELLIGENCE_TOOL, 16000, batchTimeoutMs)
        } catch (err) {
          // A single batch's Claude call failing (a transient API error, a
          // truncated/malformed response) used to abort the ENTIRE run via
          // fail()+return — losing every fact already extracted by earlier,
          // successful batches. This is a genuinely catchable, in-band
          // failure (unlike the CPU-governor kill this pipeline separately
          // guards against above, which no catch block can intercept) — so
          // it should cost this batch's files, not the whole run, EXCEPT
          // for a billing-halt classification (credit_exhausted /
          // authentication_failed): every remaining call in this run would
          // fail identically, so continuing to the next batch/stage would
          // just keep spending on calls guaranteed to fail — that's the
          // second half of the incident this closes (see haltForBilling).
          const classification = (err as { classification?: AnthropicFailureClassification })?.classification
            ?? classifyAnthropicError(err)
          const errMessage = err instanceof Error ? err.message : String(err)
          console.log(JSON.stringify({
            batch: batchIdx + 1, totalBatches: fileBatches.length,
            documents: batchFiles.map((f) => f.filename), status: 'failed',
            durationMs: Date.now() - batchStartedAt,
            classification, error: errMessage,
          }))

          if (isBillingHaltClassification(classification)) {
            await haltForBilling(classification, errMessage)
            return
          }

          // Persist this failure against every REAL file in the batch — this
          // is what lets a LATER invocation retry this exact grouping
          // smaller (forced solo batching above) instead of resending it
          // whole, and what stops it for good after too many identical
          // failures (maxConsecutiveOccurrences, inside recordAiFailure).
          // Deduplicated by real file id (dedupeRealFileIds): a page-
          // chunked PDF contributes multiple batchFiles entries
          // (`${realId}#pStart-End`) for ONE real file — recording this ONE
          // Claude-call failure once per chunk would inflate one real
          // failure into several counted occurrences (production readiness
          // review, blocking issue 2), so this call is one per underlying
          // file, not one per batch entry.
          for (const rfid of dedupeRealFileIds(batchFiles.map((f) => f.fileId))) {
            await recordAiFailure(rfid, classification, errMessage)
          }
          failedToLoadSiblings.push(...batchFiles.map((f) => f.filename))
          continue
        }
        if (!docResult) {
          console.log(JSON.stringify({
            batch: batchIdx + 1, totalBatches: fileBatches.length,
            documents: batchFiles.map((f) => f.filename), status: 'failed',
            durationMs: Date.now() - batchStartedAt,
            error: 'no structured response from document intelligence stage',
          }))
          failedToLoadSiblings.push(...batchFiles.map((f) => f.filename))
          continue
        }

        // Structured observability log — real per-batch duration and token
        // usage (from the Claude response's own usage object, via callTool's
        // internal log). Per-document token attribution isn't reported by
        // the API for a multi-document call, so this deliberately reports
        // at batch granularity rather than fabricating a per-document split.
        console.log(JSON.stringify({
          batch: batchIdx + 1, totalBatches: fileBatches.length,
          documents: batchFiles.map((f) => f.filename), status: 'processed',
          durationMs: Date.now() - batchStartedAt,
          factsFound: (docResult.facts ?? []).length,
          documentsClassified: (docResult.documents ?? []).length,
        }))

        await setStage('understanding_project')

        // Persist Stage 1 — document map (this batch)
        const docRows = (docResult.documents ?? []) as Array<Record<string, unknown>>
        const fileIndexToId: Record<number, string> = {}
        batchFiles.forEach((f, idx) => { fileIndexToId[idx] = f.fileId })

        const documentInserts = docRows
          .filter((d) => typeof d.file_index === 'number' && fileIndexToId[d.file_index as number])
          .map((d) => ({
            job_id: jobId,
            file_id: realFileId(fileIndexToId[d.file_index as number]),
            document_type: d.document_type ?? null,
            discipline: d.discipline ?? null,
            revision: d.revision ?? null,
            issue_date: d.issue_date ?? null,
            scale: d.scale ?? null,
            page_count: d.page_count ?? null,
            drawing_title: d.drawing_title ?? null,
            readability: d.readability ?? null,
            ocr_quality: d.ocr_quality ?? null,
            trade_relevance: d.trade_relevance ?? [],
            is_duplicate: d.is_duplicate ?? false,
            is_superseded: d.is_superseded ?? false,
            notes: d.notes ?? null,
          }))

        for (const d of docRows) {
          const title = (d.drawing_title as string) ?? (d.document_type as string)
          if (title) processedDocTitles.push(title)
        }

        // Persist Stage 2 — new facts (this batch), merged against both
        // pre-existing DB facts and facts extracted by earlier batches in
        // this same run (facts, kept up to date after every batch below).
        // source_file_id carries the real file id, not a project_documents
        // id — persist_document_classification (migration 050) resolves
        // file_id -> project_document_id itself, atomically with the
        // document upsert it does in the same call, so there's no need to
        // pre-resolve it here the way the old two-step write required.
        const factRows = (docResult.facts ?? []) as Array<Record<string, unknown>>
        const factInsertsBase = factRows.map((f) => ({
          job_id: jobId,
          category: f.category as string,
          key: f.key as string,
          value: String(f.value),
          source_file_id: typeof f.source_file_index === 'number' ? realFileId(fileIndexToId[f.source_file_index as number]) : null,
          page_reference: (f.page_reference as string) ?? null,
          evidence: (f.evidence as string) ?? null,
          confidence: (f.confidence as number) ?? 70,
        }))

        // duplicateIdx/merge need embeddings first (unchanged) — but
        // mergeFacts only compares category/key/value/embedding, so
        // swapping source_document_id for source_file_id above doesn't
        // affect its behaviour.
        const voyageApiKey = Deno.env.get('VOYAGE_API_KEY')
        const factTexts = factInsertsBase.map((f) => `[${f.category}] ${f.key}: ${f.value}`)
        const embeddings = factInsertsBase.length > 0 ? await embedTexts(factTexts, voyageApiKey) : []
        type FactInsertWithSourceFile = Omit<FactRow, 'source_document_id'> & { source_file_id: string | null }
        const factInserts: FactInsertWithSourceFile[] = factInsertsBase.map((f, i) => ({ ...f, embedding: embeddings[i] ?? null }))

        // Auto-supersede: a new fact for the same job_id + category + key
        // with a different value replaces the prior one instead of both
        // accumulating forever, or (below the exact-key check) a semantic
        // near-duplicate under a different label — see mergeFacts. Merges
        // against `facts`, which already includes both DB-persisted facts
        // and anything extracted by earlier batches in this run.
        // FactInsertWithSourceFile satisfies FactRow structurally (every
        // FactRow field it doesn't carry — source_document_id — is
        // optional there; mergeFacts itself only ever reads
        // category/key/value/embedding/id), so no cast is needed.
        const merge = mergeFacts(facts, factInserts, SEMANTIC_DUPLICATE_THRESHOLD)

        // Skip exact restatements (same category+key+value as an existing
        // active fact) — inserting them would double-count the same
        // real-world fact and let a re-uploaded document burn prompt-budget
        // slots other documents should have had.
        const duplicateIdx = new Set(merge.duplicateNewFactIndexes)
        const factsToInsert = factInserts.filter((_, i) => !duplicateIdx.has(i))
        if (duplicateIdx.size > 0) {
          console.log(JSON.stringify({ stage: 'understanding_project', duplicate_restatements_skipped: duplicateIdx.size }))
        }

        // Single atomic write: document metadata (extraction_status set to
        // 'complete' inside the function) and every surviving fact for
        // this batch, together — see migration 050. Either both land, or
        // neither does; there is no window where extraction_status can
        // read 'complete' while its facts are missing, which is exactly
        // the false-completion bug that let retries silently reprocess
        // already-classified documents.
        if (documentInserts.length > 0 || factsToInsert.length > 0) {
          const { data: persistResult, error: persistError } = await supabase.rpc('persist_document_classification', {
            p_job_id: jobId,
            p_documents: documentInserts,
            p_facts: factsToInsert.map((f) => ({
              source_file_id: f.source_file_id,
              category: f.category, key: f.key, value: f.value,
              page_reference: f.page_reference, evidence: f.evidence,
              confidence: f.confidence, embedding: f.embedding,
            })),
            p_superseded_ids: merge.supersededIds,
          })
          if (persistError) {
            console.error('persist_document_classification RPC failed:', persistError)
          } else {
            const result = persistResult as { documents: Array<{ file_id: string; project_document_id: string }>; fact_ids: string[] }
            const fileIdToDocId = new Map((result.documents ?? []).map((d) => [d.file_id, d.project_document_id]))
            const insertedIds = result.fact_ids ?? []

            facts = [
              ...facts.filter((f) => !merge.supersededKeys.includes(`${f.category}::${f.key}`)),
              ...factsToInsert.map((f, i) => ({
                category: f.category, key: f.key, value: f.value,
                evidence: f.evidence, confidence: f.confidence, embedding: f.embedding,
                id: insertedIds[i],
                source_document_id: f.source_file_id ? (fileIdToDocId.get(f.source_file_id) ?? null) : null,
              })),
            ]
          }
        }
      }

      // Re-persist: a batch failure inside the loop above (Claude API error,
      // malformed response) can add to failedToLoadSiblings well after the
      // earlier write right after the sibling-loading loop — without this,
      // a later-stage failure or timeout would only ever surface storage
      // load failures, not batch-classification failures, to the builder.
      if (failedToLoadSiblings.length > 0) {
        await supabase.from('files').update({ failed_sibling_filenames: failedToLoadSiblings }).eq('id', fileId)
      }
    }

    if (facts.length === 0) {
      const notes: string[] = []
      if (skippedSiblings.length > 0) {
        notes.push(`excluded, combined size over the 20MB analysis limit: ${skippedSiblings.join(', ')}`)
      }
      if (failedToLoadSiblings.length > 0) {
        notes.push(`failed to load or process: ${failedToLoadSiblings.join(', ')}`)
      }
      const note = notes.length > 0 ? ` (${notes.join('; ')} — re-upload separately or split into a smaller batch)` : ''
      await fail(`No project facts could be established from the provided documents${note}`)
      return
    }

    {
      const { count: documentsCount } = await supabase
        .from('project_documents')
        .select('*', { count: 'exact', head: true })
        .eq('job_id', jobId)
      console.log(JSON.stringify({
        event: 'stage_checkpoint', job_id: jobId, batch_id: parentJobId ?? null,
        stage: 'document_intelligence', completed_at: new Date().toISOString(),
        documents_count: documentsCount ?? null, facts_count: facts.length,
        scope_items_count: null, quote_created: false,
      }))
    }

    // ── Stage 3 + 4: Scope Reasoning + Gap Detection ───────────────────────
    await setStage('reasoning_scope')

    // Document-balanced selection, NOT global confidence ordering. Global
    // ordering had a proven failure: past the fact cap, the lowest-
    // confidence facts are evicted first, and confidence tracks document
    // READABILITY — so a scanned engineering set could lose its entire
    // contribution (0% survival) while crisp schedules kept 100%, silently
    // reverting the estimate to plans-only for exactly the trades where
    // wrong quantities are most expensive. Every source document is now
    // guaranteed its floor of the budget; the remainder still goes to the
    // highest-confidence facts. See selectFactsBalancedBySource.
    const factsForPrompt = selectFactsBalancedBySource(facts)

    // Per-document survival accounting — the number pair ("38 extracted,
    // 12 used") that makes "did WorkA actually use my drawings?" answerable
    // from logs and, via quotes.document_contribution below, from the UI.
    const factSelectionSummary = summarizeFactSelection(facts, factsForPrompt)
    console.log(JSON.stringify({
      stage: 'fact_selection',
      facts_active: facts.length,
      facts_in_prompt: factsForPrompt.length,
      per_source: factSelectionSummary,
    }))

    // Evidence capped per-fact (STAGE3_MAX_EVIDENCE_CHARS, pipeline-logic.ts)
    // — category/key/value/confidence are never truncated, only the
    // free-text evidence excerpt. project_facts.evidence itself is
    // untouched; this only bounds what's copied into this one prompt. See
    // the Stage 3 reliability investigation this closes.
    const factsBlock = factsForPrompt.map((f) => formatFactForScopePrompt(f)).join('\n')

    // ── Stage 3 checkpoint (migration 053) ──────────────────────────────────
    // A retry against the SAME batch (parent_job_id unchanged — this is how
    // the recovery cron's find_stuck_batches_needing_classification_retry
    // re-triggers a wall-clock-stalled run, see bailForWallClockBudget above)
    // that already completed Stage 3 + Gap Detection without a blocking
    // question skips straight to Stage 6, reusing the persisted scope_items
    // instead of re-running the whole reasoning call. This is what makes a
    // retry strictly cheaper rather than repeating the exact call that ran
    // out of wall-clock room last time. A genuinely NEW upload for this job
    // gets its own fresh document_processing_batches row
    // (scope_reasoning_completed_at null by default), so incremental uploads
    // still correctly re-run Stage 3 over the newly-merged fact base — this
    // is per-batch, not per-job.
    let scopeAlreadyComplete = false
    if (parentJobId) {
      const { data: batchRow } = await supabase
        .from('document_processing_batches')
        .select('scope_reasoning_completed_at')
        .eq('id', parentJobId)
        .single()
      scopeAlreadyComplete = Boolean(batchRow?.scope_reasoning_completed_at)
    }

    if (scopeAlreadyComplete) {
      console.log(JSON.stringify({
        stage: 'reasoning_scope', status: 'skipped_checkpoint', job_id: jobId, batch_id: parentJobId,
        reason: 'scope_reasoning_completed_at already set for this batch — reusing persisted scope_items instead of re-running Stage 3',
      }))
    } else {
      const scopeSystemPrompt = `You are a senior Australian residential construction estimator. Reason about scope like an experienced estimator would — combine evidence across documents rather than treating each fact in isolation. For each relevant trade, state what is included, what is excluded, dependencies, and assumptions. Only raise a clarifying question when missing information would materially change scope or quantities for a trade — most small gaps should NOT be questions, they get handled later as per-line assumptions. Keep total questions minimal and only mark "blocking" when the estimate genuinely cannot proceed responsibly without an answer (e.g. a double-storey addition with no structural drawings at all) — note that "blocking" flags a question for priority review, it does NOT stop the estimate from being generated; the pipeline always continues using your suggested_assumption (or a conservative default if you don't provide one), so always give your best industry-standard default when one exists.${memoryContext}`

      // Stage 3 reliability: identity of THIS batch's Stage 3 input,
      // independent of whether it ends up chunked into 1 or several calls
      // below — the escalation history (migration 059) tracks "has this
      // merged fact base + trade list already proven doomed," not any one
      // call's exact request shape. Same hashing approach ai-gateway.ts's
      // hashAiInput already uses for idempotency, reused rather than
      // reinvented.
      const stage3InputHash = await hashAiInput([factsBlock, TRADE_CATEGORIES, memoryContext])

      // ── Pre-call skip: never resend an input already proven doomed ──────
      // Read-only lookup (a plain SELECT, not FOR UPDATE — matches the
      // scopeAlreadyComplete checkpoint read just above; only the WRITE
      // after a failure needs the atomic RPC). Stage 1/2's files.ai_failure_
      // count is a different, unrelated axis — untouched here.
      let stage3History: Stage3FailureHistory = { inputHash: null, classification: null, count: 0 }
      if (parentJobId) {
        const { data: failureRow } = await supabase
          .from('document_processing_batches')
          .select('stage3_failure_input_hash, stage3_failure_classification, stage3_failure_count')
          .eq('id', parentJobId)
          .single()
        if (failureRow) {
          stage3History = {
            inputHash: failureRow.stage3_failure_input_hash ?? null,
            classification: (failureRow.stage3_failure_classification as AnthropicFailureClassification | null) ?? null,
            count: failureRow.stage3_failure_count ?? 0,
          }
        }
      }
      if (shouldSkipStage3Call(stage3History, stage3InputHash)) {
        console.log(JSON.stringify({
          stage: 'reasoning_scope', status: 'skipped_exhausted_retries', job_id: jobId, batch_id: parentJobId,
          prior_classification: stage3History.classification, prior_count: stage3History.count,
          reason: 'identical Stage 3 input already failed the maximum tolerated number of times — not resending',
        }))
        await fail(`Scope reasoning previously failed repeatedly with an unchanged project fact base (${stage3History.classification}) — resolve the underlying issue or upload additional documents before retrying.`)
        return
      }

      // ── Budget-aware trade chunking (replaces the old fixed-2-chunk-or-bail
      // design) ──────────────────────────────────────────────────────────
      // Root cause closed here: WALL_CLOCK_SAFETY_MS (340s) is LESS than
      // 2 x STAGE3_PER_CALL_TIMEOUT_MS (440s), so a chunked project can
      // never fit both desired chunks in one invocation no matter how
      // little time Stage 1/2 used — the old design either ran the full
      // plan (risking exactly the wall-clock overrun this exists to
      // prevent) or bailed with zero progress. planStage3Chunks computes
      // how many right-sized chunks actually fit THIS invocation's
      // remaining budget; document_processing_batches.stage3_completed_
      // trade_ids (migration 060) persists which trades are durably done
      // so a later invocation (a fresh wall-clock window) resumes with
      // only the remaining trades — never repeating finished work, never
      // starting a call that can't finish.
      let completedTradeIds: number[] = []
      if (parentJobId) {
        const { data: progressRow } = await supabase
          .from('document_processing_batches')
          .select('stage3_completed_trade_ids')
          .eq('id', parentJobId)
          .single()
        completedTradeIds = (progressRow?.stage3_completed_trade_ids as number[] | null) ?? []
      }
      const remainingTrades = TRADE_CATEGORIES.filter((t) => !completedTradeIds.includes(t.id))

      if (remainingTrades.length === 0) {
        // Defensive only — scopeAlreadyComplete above should already have
        // caught the "every trade done" case. Nothing left to reason
        // about; fall through to Stage 6 with what's already persisted.
        console.log(JSON.stringify({
          stage: 'reasoning_scope', status: 'all_trades_already_complete', job_id: jobId, batch_id: parentJobId,
        }))
      } else {
        const remainingBudgetMs = WALL_CLOCK_SAFETY_MS - (Date.now() - startedAt)
        const plan = planStage3Chunks(remainingTrades, remainingBudgetMs, factsForPrompt.length)

        if (plan.chunksToRunNow.length === 0) {
          // No room for even one call this invocation — never start a call
          // that cannot finish. Zero spend, everything deferred to a later
          // invocation with a fresh budget.
          await bailForWallClockBudget('reasoning_scope', STAGE3_PER_CALL_TIMEOUT_MS)
          return
        }

        const scopeStartedAt = Date.now()
        const chunkResults: ScopeReasoningResult[] = []
        try {
          for (const [chunkIndex, tradeChunk] of plan.chunksToRunNow.entries()) {
            const scopeUserContent = [{
              type: 'text' as const,
              text: plan.chunksToRunNow.length > 1 || completedTradeIds.length > 0
                ? `PROJECT FACTS:\n${factsBlock}\n\nTrade categories to reason about in THIS call (only return entries for these — the remaining trades are covered by a separate call, do not include them here):\n${tradeChunk.map((c) => `${c.id}. ${c.name}`).join('\n')}\n\nUse the reason_about_scope tool.`
                : `PROJECT FACTS:\n${factsBlock}\n\nTrade categories:\n${tradeChunk.map((c) => `${c.id}. ${c.name}`).join('\n')}\n\nUse the reason_about_scope tool.`,
            }]

            // Was 4096, then 8192 -- both truncated (confirmed via stop_reason log)
            // on a real 75-fact project reasoning across 13 trades. Match the other
            // two stages' proven 16000 rather than guessing at yet another cap.
            //
            // STAGE3_PER_CALL_TIMEOUT_MS (220s) widened from the 150s default:
            // confirmed in production on a 108-fact, 4-document project — the
            // call was cleanly aborted by OUR OWN AbortController at exactly
            // 150002ms (classification: application_timeout). Budget-aware
            // chunking (above) now gives large-fact-base projects a genuine
            // "smaller request, persisted across invocations" lever on top of
            // this — 220s per call stays well inside Supabase's real 400s
            // isolate wall-clock ceiling even when this stage runs after
            // Stage 1/2 in the same invocation.
            const chunkResult = await callTool(
              anthropic, { supabase, builderId, jobId, stage: 'stage_scope_reasoning' },
              scopeSystemPrompt, scopeUserContent, SCOPE_REASONING_TOOL, 16000, STAGE3_PER_CALL_TIMEOUT_MS
            ) as ScopeReasoningResult
            chunkResults.push(chunkResult)

            // Persist THIS chunk's scope + progress immediately — durability
            // across a crash, not just across a clean bail. A retry that
            // re-enters this loop after a crash mid-way still doesn't
            // re-spend on a chunk that already succeeded: this write lands
            // before the loop ever reaches Anthropic again for these trades.
            const chunkScopeRows = (chunkResult.scope ?? []) as Array<Record<string, unknown>>
            if (chunkScopeRows.length > 0) {
              const chunkScopeInserts = chunkScopeRows
                .filter((s) => typeof s.trade_category_id === 'number')
                .map((s) => ({
                  job_id: jobId,
                  trade_category_id: s.trade_category_id,
                  included_scope: s.included_scope ?? [],
                  excluded_scope: s.excluded_scope ?? [],
                  dependencies: s.dependencies ?? [],
                  assumptions: s.assumptions ?? [],
                  uncertainty_notes: s.uncertainty_notes ?? null,
                  confidence: s.confidence ?? null,
                }))
              if (chunkScopeInserts.length > 0) {
                await supabase.from('scope_items').upsert(chunkScopeInserts, { onConflict: 'job_id,trade_category_id' })
              }
            }
            if (parentJobId) {
              completedTradeIds = Array.from(new Set([...completedTradeIds, ...tradeChunk.map((t) => t.id)]))
              await supabase.from('document_processing_batches').update({
                stage3_completed_trade_ids: completedTradeIds,
                updated_at: new Date().toISOString(),
              }).eq('id', parentJobId)
            }

            console.log(JSON.stringify({
              stage: 'reasoning_scope', status: 'chunk_processed', job_id: jobId, batch_id: parentJobId,
              chunk: chunkIndex + 1, chunk_count: plan.chunksToRunNow.length,
              tradesInChunk: tradeChunk.length, tradesReasoned: (chunkResult.scope ?? []).length,
              trades_completed_total: completedTradeIds.length, trades_remaining: TRADE_CATEGORIES.length - completedTradeIds.length,
            }))

            // A blocking question no longer stops further chunks — the
            // pipeline always continues to Stage 6 (see this stage's own
            // section below), so abandoning the remaining trades here would
            // leave whole trades missing from the estimate instead of just
            // one flagged, low-confidence assumption. Still reasoned about
            // every chunk exactly as before; only the early exit is gone.
          }
        } catch (err) {
          const classification = (err as { classification?: AnthropicFailureClassification })?.classification ?? classifyAnthropicError(err)
          const errMessage = err instanceof Error ? err.message : String(err)
          console.log(JSON.stringify({ stage: 'reasoning_scope', status: 'failed', durationMs: Date.now() - scopeStartedAt, factsInPrompt: factsForPrompt.length, chunkCount: plan.chunksToRunNow.length, classification, error: errMessage }))
          if (isBillingHaltClassification(classification)) {
            await haltForBilling(classification, errMessage)
            return
          }
          // Race-safe, atomic — mirrors record_ai_failure (migration 043),
          // keyed by batch + input hash (migration 059) instead of files.id,
          // since Stage 3 has no per-file correspondence. Best-effort: a
          // failure to RECORD the failure must never mask the original error.
          if (parentJobId) {
            try {
              const { data: recordData, error: recordErr } = await supabase.rpc('record_stage3_failure', {
                p_batch_id: parentJobId,
                p_input_hash: stage3InputHash,
                p_classification: classification,
                p_max_occurrences: maxConsecutiveOccurrences(classification),
              })
              if (recordErr) throw recordErr
              const recordResult = (recordData as Array<{ classification: string; occurrence_count: number; stopped: boolean }> | null)?.[0]
              console.log(JSON.stringify({
                event: 'stage3_failure_recorded', job_id: jobId, batch_id: parentJobId, classification,
                consecutive_count: recordResult?.occurrence_count ?? null, stopped: recordResult?.stopped ?? false,
              }))
            } catch (recordErr) {
              console.error('record_stage3_failure RPC failed:', recordErr)
            }
          }
          await fail(`Scope reasoning call failed: ${errMessage}`)
          return
        }

        const scopeResult: MergedScopeReasoningResult = mergeScopeReasoningResults(chunkResults)
        if (scopeResult.tradeCollisions.length > 0) {
          // Should be rare — chunks are given disjoint trade subsets — but
          // if a chunk didn't fully respect its assigned trades, both
          // sides are merged (not silently dropped, see
          // mergeConflictingScopeEntries) and that merge is logged here so
          // it's visible rather than only discoverable by reading
          // uncertainty_notes after the fact.
          console.log(JSON.stringify({
            stage: 'reasoning_scope', status: 'trade_collision_merged', job_id: jobId,
            batch_id: parentJobId, trade_category_ids: scopeResult.tradeCollisions,
          }))
        }
        console.log(JSON.stringify({ stage: 'reasoning_scope', status: 'processed', durationMs: Date.now() - scopeStartedAt, factsInPrompt: factsForPrompt.length, tradesReasoned: (scopeResult.scope ?? []).length, questionsRaised: (scopeResult.clarifying_questions ?? []).length }))

        await setStage('detecting_gaps')

        // De-duped against already-open questions for this job before either
        // insert below. Previously this could only ever run once for
        // non-blocking questions per job in practice (a blocking question
        // always halted the pipeline, so Stage 3 could never re-run while
        // one was open) — now that blocking no longer stops anything,
        // Stage 3 can genuinely run again (a new incremental upload) while
        // an earlier blocking question is still unanswered, and Claude
        // re-raising the same real gap in near-identical wording is
        // expected, not a bug. Without this check that would insert a
        // duplicate row every run instead of leaving the original in place.
        const { data: alreadyOpenRows } = await supabase
          .from('clarifying_questions')
          .select('question')
          .eq('job_id', jobId)
          .eq('status', 'open')
        const alreadyOpenQuestions = new Set(((alreadyOpenRows ?? []) as Array<{ question: string }>).map((r) => r.question))

        const questions = ((scopeResult.clarifying_questions ?? []) as Array<Record<string, unknown>>)
          .filter((q) => !alreadyOpenQuestions.has(q.question as string))
        const blockingQuestions = questions.filter((q) => q.blocking === true)
        const nonBlocking = questions.filter((q) => q.blocking !== true)
        if (nonBlocking.length > 0) {
          await supabase.from('clarifying_questions').insert(
            nonBlocking.map((q) => ({
              job_id: jobId, question: q.question, reason: q.reason,
              trade_category_id: q.trade_category_id ?? null, blocking: false, status: 'open' as const,
            }))
          )
        }

        if (plan.hasMoreAfterThisInvocation) {
          // Genuine forward progress this invocation (chunksToRunNow > 0,
          // all persisted above), but the remaining trades didn't fit —
          // defer them, cleanly, to a later invocation with a fresh
          // wall-clock window. Unrelated to blocking questions (that no
          // longer stops anything — see below): this is purely a compute-
          // budget deferral, resolved automatically by the next invocation,
          // never exposed to the builder as something to wait on.
          console.log(JSON.stringify({
            stage: 'reasoning_scope', status: 'partial_progress_deferred', job_id: jobId, batch_id: parentJobId,
            trades_completed_total: completedTradeIds.length, trades_remaining: TRADE_CATEGORIES.length - completedTradeIds.length,
          }))
          if (parentJobId) {
            await supabase.from('document_processing_batches').update({
              stall_stage: 'reasoning_scope',
              stall_reason: `Stage 3 partially complete (${completedTradeIds.length}/${TRADE_CATEGORIES.length} trades reasoned) — remaining trades deferred to a future invocation with a fresh wall-clock budget.`,
              stalled_at: new Date().toISOString(),
            }).eq('id', parentJobId)
          }
          return
        }

        // Non-blocking estimation: a blocking question is persisted (audit
        // trail, and the builder can still answer it via the existing
        // /clarify resume flow) but no longer stops the pipeline here —
        // Stage 6 below always runs, using an explicit, disclosed
        // assumption in place of the missing answer (see
        // buildConservativeAssumption, pipeline-logic.ts). WorkA should
        // always produce an estimate on the first run.
        if (blockingQuestions.length > 0) {
          const questionInserts = blockingQuestions.map((q) => ({
            job_id: jobId,
            question: q.question,
            reason: q.reason,
            trade_category_id: q.trade_category_id ?? null,
            blocking: true,
            status: 'open' as const,
            suggested_assumption: (q.suggested_assumption as string | null) ?? null,
          }))
          await supabase.from('clarifying_questions').insert(questionInserts)
        }

        // Reaching here means every remaining trade was reasoned about this
        // invocation (plan.hasMoreAfterThisInvocation was false) — genuinely
        // done, whether or not a blocking question was raised. Durable
        // Stage 3 checkpoint: a subsequent same-batch retry will read this
        // and skip straight to Stage 6. (A builder answering a blocking
        // question afterwards goes through the /clarify route instead,
        // which always re-runs Stage 3 regardless of this checkpoint — see
        // that route's own comment.)
        if (parentJobId) {
          await supabase.from('document_processing_batches')
            .update({ scope_reasoning_completed_at: new Date().toISOString() })
            .eq('id', parentJobId)
        }
      }
    }

    // ── Stage 6: Estimate Generation (spec Stage 5) ────────────────────────
    await setStage('generating_estimate')

    // .order('trade_category_id') — same load-bearing reason as the
    // existingFacts/existingDocs/document_processing_jobs fixes above: this
    // feeds scopeBlock -> estimateUserContent, one of Stage 6's
    // guardedClaudeCall inputParts (via callTool's `content` argument). An
    // unordered fetch here means an unchanged scope_items set could still
    // hash differently across retries, defeating idempotent reuse for
    // Stage 6 the same way it did for Stage 3 before the existingFacts fix.
    // Found during the R-03 follow-up review (production validation pass
    // after Phase 1) — the earlier pass covered Stage 1/2 and Stage 3's
    // direct inputs but had not checked Stage 6's.
    const { data: scopeForEstimate } = await supabase
      .from('scope_items')
      .select('trade_category_id, included_scope, excluded_scope, assumptions, uncertainty_notes')
      .eq('job_id', jobId)
      .order('trade_category_id', { ascending: true })

    console.log(JSON.stringify({
      event: 'stage_checkpoint', job_id: jobId, batch_id: parentJobId ?? null,
      stage: 'reasoning_scope', completed_at: new Date().toISOString(),
      documents_count: null, facts_count: facts.length,
      scope_items_count: (scopeForEstimate ?? []).length, quote_created: false,
    }))

    // ── Non-blocking estimation: conservative assumptions ───────────────────
    // Read fresh from the DB rather than the in-memory blockingQuestions
    // from the Stage 3/4 section above — that variable is scoped to a
    // branch that's skipped entirely on a checkpoint-skip retry
    // (scopeAlreadyComplete) or on a resume, but an open blocking question
    // from an EARLIER invocation still needs its conservative assumption
    // applied every time Stage 6 runs, not only the invocation that first
    // raised it.
    const { data: openBlockingQuestions } = await supabase
      .from('clarifying_questions')
      .select('question, reason, trade_category_id, suggested_assumption')
      .eq('job_id', jobId)
      .eq('blocking', true)
      .eq('status', 'open')
      .order('created_at', { ascending: true })

    const conservativeAssumptions: ConservativeAssumption[] = ((openBlockingQuestions ?? []) as Array<{
      question: string; reason: string; trade_category_id: number | null; suggested_assumption: string | null
    }>).map((q) => buildConservativeAssumption(q))

    if (conservativeAssumptions.length > 0) {
      console.log(JSON.stringify({
        event: 'conservative_assumptions_applied', job_id: jobId, batch_id: parentJobId ?? null,
        count: conservativeAssumptions.length,
        trades: conservativeAssumptions.map((a) => a.trade_category_id),
      }))
    }

    const scopeBlock = (scopeForEstimate ?? [])
      .map((s: Record<string, unknown>) => `Trade ${s.trade_category_id} (${TRADE_CATEGORIES.find((t) => t.id === s.trade_category_id)?.name}): included = ${(s.included_scope as string[]).join('; ')}. excluded = ${(s.excluded_scope as string[]).join('; ')}.`)
      .join('\n')

    const estimateSystemPrompt = `You are a senior Australian residential quantity surveyor producing a full construction cost takeoff. Base every quantity on the project facts and scope below — never invent a quantity or a material. When a quantity cannot be derived from anything provided, set manual_input_required = true and leave quantity/unit null rather than guessing. Produce a complete takeoff across all in-scope trades (typically 80-250 line items for a full residential project — fewer for a small job, do not pad to hit a number). Use Australian units only (m2, lm, m3, each, lot, weeks, hours). Descriptions must be specific ("Concrete slab — 125mm ground floor", not "Concrete"). Set pricing_type: measured (derived from a dimension/schedule), pc_allowance (prime cost item), or provisional_sum (scope TBD by others). If the source documents are themselves a priced estimate/BOQ, extract the printed unit rate and line total into document_rate/document_total as COST figures (exclude margin and GST) — otherwise leave them null so the platform's rate engine can price the line.`

    const estimateUserContent = [{ type: 'text' as const, text: `PROJECT FACTS:\n${factsBlock}\n\nSCOPE REASONING:\n${scopeBlock}\n\nUse the generate_estimate tool.` }]

    if (!hasWallClockBudget(150_000)) {
      await bailForWallClockBudget('generating_estimate', 150_000)
      return
    }

    const estimateStartedAt = Date.now()
    let estimateResult: { line_items?: unknown[] } | null = null
    try {
      estimateResult = await callTool(anthropic, { supabase, builderId, jobId, stage: 'stage_estimate_generation' }, estimateSystemPrompt, estimateUserContent, ESTIMATE_GENERATION_TOOL, 16000)
    } catch (err) {
      const classification = (err as { classification?: AnthropicFailureClassification })?.classification ?? classifyAnthropicError(err)
      const errMessage = err instanceof Error ? err.message : String(err)
      console.log(JSON.stringify({ stage: 'generating_estimate', status: 'failed', durationMs: Date.now() - estimateStartedAt, classification, error: errMessage }))
      if (isBillingHaltClassification(classification)) {
        await haltForBilling(classification, errMessage)
        return
      }
      await fail(`Estimate generation call failed: ${errMessage}`)
      return
    }
    if (!estimateResult || !estimateResult.line_items || estimateResult.line_items.length === 0) {
      console.log(JSON.stringify({ stage: 'generating_estimate', status: 'failed', durationMs: Date.now() - estimateStartedAt, reason: 'no line items returned' }))
      await fail('Estimate generation returned no line items')
      return
    }
    console.log(JSON.stringify({ stage: 'generating_estimate', status: 'processed', durationMs: Date.now() - estimateStartedAt, lineItems: estimateResult.line_items.length }))

    // ── Validation gates ────────────────────────────────────────────────────
    await setStage('validating')

    // Deterministic confidence cap for any trade a conservative assumption
    // applies to — never relies on Claude's own Stage 6 confidence to
    // already reflect an unanswered blocking question (see
    // capConfidenceForBlockingTrade, pipeline-logic.ts). Confidence-only:
    // does not touch quantity, rate, or pricing_type — Stage 6 pricing
    // itself is unchanged.
    const rawItems = (estimateResult.line_items as Array<Record<string, unknown>>).map((item) => {
      if (conservativeAssumptions.length === 0) return item
      if (!conservativeAssumptionAppliesToTrade(conservativeAssumptions, (item.trade_category_id as number) ?? null)) return item
      return { ...item, confidence: capConfidenceForBlockingTrade((item.confidence as number) ?? 100) }
    })
    const assumptionsToInsert: Array<{ description: string; gate: 1 | 2 | 3; message: string }> = []

    const validated = rawItems
      .filter((item) => typeof item.trade_category_id === 'number' && item.trade_category_id >= 1 && item.trade_category_id <= 13)
      .map((item) => {
        const docPrice = deriveDocPrice(item.document_rate, item.document_total, (item.quantity as number) ?? null)
        const gateItem: GateableItem = {
          description: String(item.description ?? ''),
          quantity: (item.quantity as number) ?? null,
          unit: (item.unit as string) ?? null,
          dimensions_string: (item.dimensions_string as string) ?? null,
          pricing_type: (item.pricing_type as string) ?? 'measured',
          has_document_price: docPrice.total !== null,
          manual_input_required: item.manual_input_required === true,
        }
        const gateResult = applyValidationGates(gateItem)
        if (gateResult.gate && gateResult.message) {
          assumptionsToInsert.push({ description: gateItem.description, gate: gateResult.gate, message: gateResult.message })
        }
        return { ...item, ...gateResult, _docRate: docPrice.rate, _docTotal: docPrice.total }
      })

    // ── Stage 6/8 wiring: build the quote ───────────────────────────────────
    await setStage('building_quote')

    // Incremental upload: reuse an existing draft/pending_review quote for
    // this job rather than creating a second one, so previously-resolved
    // assumptions on unrelated line items are preserved untouched.
    const { data: existingQuote } = await supabase
      .from('quotes')
      .select('id')
      .eq('job_id', jobId)
      .in('status', ['draft', 'pending_review'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    let quoteId: string
    if (existingQuote) {
      quoteId = existingQuote.id
    } else {
      const { data: quoteRow, error: quoteErr } = await supabase
        .from('quotes')
        .insert({ job_id: jobId, builder_id: builderId, status: 'draft', total_cost: null, margin_pct: null, confidence_score: null, version: 1 })
        .select()
        .single()
      if (quoteErr || !quoteRow) { await fail('Could not create quote record'); return }
      quoteId = quoteRow.id
    }

    // Mark this job's current quote (migration 061) — the read above is a
    // SELECT-then-INSERT with no lock behind it, so two concurrent runs for
    // this job could each insert their own quote row believing neither saw
    // an existing one. quotes_one_current_per_job (a partial unique index)
    // is what actually prevents both from ever being treated as authoritative
    // — the second call here simply fails its own is_current flip and the
    // first writer's quote stays current, rather than the job silently
    // having two "active" quotes with nothing to say which one is real.
    // Best-effort by design: never lets quote creation itself fail because
    // this bookkeeping call did.
    {
      const { error: currentErr } = await supabase.rpc('set_current_quote', { p_job_id: jobId, p_quote_id: quoteId })
      if (currentErr) console.error('set_current_quote failed:', currentErr.message)
    }

    // ── Non-blocking estimation: reconcile conservative-assumption rows ────
    // gate IS NULL distinguishes these from Gate 1-3 assumptions (never
    // touched here). Two things happen on every Stage 6 run, not just the
    // first: (1) a currently-open blocking question not yet represented as
    // an assumption row gets one — covers both the fresh case and a
    // checkpoint-skip retry reusing an earlier invocation's questions; (2)
    // a row whose question is no longer open (the builder answered it via
    // /clarify) is auto-resolved, so "review required" actually shrinks as
    // things get answered instead of accumulating forever. Best-effort:
    // this bookkeeping must never fail the estimate it describes.
    try {
      // line_item_id IS NULL disambiguates from a pre-migration-026 legacy
      // Gate 1-3 row, which can also have gate IS NULL (written before that
      // column existed) but always has line_item_id set — these rows never do.
      const { data: existingConservative } = await supabase
        .from('assumptions')
        .select('id, description, resolution_type')
        .eq('quote_id', quoteId)
        .is('gate', null)
        .is('line_item_id', null)

      const existingByQuestion = new Map(
        ((existingConservative ?? []) as Array<{ id: string; description: string; resolution_type: string | null }>)
          .map((r) => [r.description, r])
      )
      const currentlyOpenQuestions = new Set(conservativeAssumptions.map((a) => a.question))

      const newRows = conservativeAssumptions
        .filter((a) => !existingByQuestion.has(a.question))
        .map((a) => ({
          quote_id: quoteId,
          line_item_id: null,
          description: a.question,
          assumed_value: a.assumed_value,
          reason: a.reason,
          confidence_penalty: a.confidence_penalty,
          trade_category_id: a.trade_category_id,
          gate: null,
          resolution_type: null,
          resolved_at: null,
          resolved_by: null,
        }))
      if (newRows.length > 0) {
        await supabase.from('assumptions').insert(newRows)
      }

      const staleRowIds = Array.from(existingByQuestion.values())
        .filter((r) => r.resolution_type === null && !currentlyOpenQuestions.has(r.description))
        .map((r) => r.id)
      if (staleRowIds.length > 0) {
        await supabase.from('assumptions').update({
          resolution_type: 'accepted',
          resolved_at: new Date().toISOString(),
          resolved_by: 'WorkA (auto-resolved: clarified)',
        }).in('id', staleRowIds)
      }
    } catch (reconcileErr) {
      console.error('conservative assumption reconciliation failed:', reconcileErr)
    }

    // ── Document contribution report (migration 039) ──────────────────────
    // The durable answer to "did WorkA actually use my drawings?": for every
    // source document, how many facts it contributed to the job and how many
    // made it into the prompt this estimate was generated from — plus
    // anything excluded or failed outright. Written best-effort: the report
    // failing must never fail the estimate it describes.
    try {
      const { data: docsForReport } = await supabase
        .from('project_documents')
        .select('id, file_id, drawing_title, document_type')
        .eq('job_id', jobId)
      const docRowsForReport = (docsForReport ?? []) as Array<{ id: string; file_id: string; drawing_title: string | null; document_type: string | null }>
      const fileIds = docRowsForReport.map((d) => d.file_id).filter(Boolean)
      const { data: fileNames } = fileIds.length > 0
        ? await supabase.from('files').select('id, filename').in('id', fileIds)
        : { data: [] }
      const filenameByFileId = new Map(((fileNames ?? []) as Array<{ id: string; filename: string }>).map((f) => [f.id, f.filename]))
      const summaryBySource = new Map(factSelectionSummary.map((s) => [s.source_document_id, s]))

      const documentContribution = {
        documents: docRowsForReport.map((d) => {
          const s = summaryBySource.get(d.id)
          return {
            document_id: d.id,
            name: filenameByFileId.get(d.file_id) ?? d.drawing_title ?? d.document_type ?? 'Document',
            facts_extracted: s?.facts_extracted ?? 0,
            facts_used: s?.facts_used ?? 0,
          }
        }),
        // Builder answers from the clarify flow and any pre-schema facts —
        // real influence with no source document to attribute it to.
        other_sources: summaryBySource.get(null)
          ? { facts_extracted: summaryBySource.get(null)!.facts_extracted, facts_used: summaryBySource.get(null)!.facts_used }
          : null,
        excluded: skippedSiblings,
        failed: failedToLoadSiblings,
        generated_at: new Date().toISOString(),
      }
      await supabase.from('quotes').update({ document_contribution: documentContribution }).eq('id', quoteId)
    } catch (reportErr) {
      console.log(JSON.stringify({ stage: 'building_quote', document_contribution_failed: reportErr instanceof Error ? reportErr.message : String(reportErr) }))
    }

    // Avoid re-inserting a line item that already exists on this quote for
    // the same trade + description (best-effort de-dupe on incremental runs).
    const { data: existingLineItems } = await supabase
      .from('quote_line_items')
      .select('trade_category_id, description')
      .eq('quote_id', quoteId)
    const existingKeys = new Set((existingLineItems ?? []).map((li: Record<string, unknown>) => `${li.trade_category_id}::${String(li.description).trim().toLowerCase()}`))

    const toInsert = validated.filter((item) => {
      if (item.assumption_status === 'excluded') return true // still recorded, filtered from insert below
      const key = `${item.trade_category_id}::${String(item.description).trim().toLowerCase()}`
      return !existingKeys.has(key)
    })

    const lineItemInserts = toInsert
      .filter((item) => item.assumption_status !== 'excluded')
      .map((item) => ({
        quote_id: quoteId,
        trade_category_id: item.trade_category_id,
        description: item.description,
        quantity: item.manual_input_required ? null : (item.quantity ?? null),
        unit: item.manual_input_required ? null : (item.unit ?? null),
        rate: item._docRate ?? null,
        total: item._docTotal ?? null,
        confidence: item.confidence ?? 50,
        dimensions_string: item.dimensions_string ?? null,
        is_assumption: item.is_assumption ?? false,
        assumption_status: item.assumption_status ?? null,
        pricing_type: item.pricing_type ?? 'measured',
        source_ref: item.source_ref ?? null,
        margin_pct: item.pricing_type === 'provisional_sum' ? 0 : 0.15,
      }))

    let unresolvedCount = 0
    if (lineItemInserts.length > 0) {
      // Upsert with ignoreDuplicates instead of a plain insert: the app-level
      // existingKeys filter above only guards against rows already committed
      // to the DB, not against two concurrent runs racing this exact insert
      // (or the model emitting the same trade+description twice in one
      // response). The unique index from migration 030 makes that a no-op
      // conflict here instead of a duplicate row.
      const { data: insertedItemsRaw, error: insertErr } = await supabase
        .from('quote_line_items')
        .upsert(lineItemInserts, { onConflict: 'quote_id,trade_category_id,description', ignoreDuplicates: true })
        .select()
      if (insertErr) {
        await fail(`Line items could not be saved: ${insertErr.message}`)
        return
      }
      // ignoreDuplicates means a row skipped as a conflict is legitimately
      // absent from the RETURNING set — an empty array here (all rows
      // happened to already exist) is success, not a failure.
      const insertedItems = insertedItemsRaw ?? []

      const relevantAssumptions = assumptionsToInsert.filter((a) => toInsert.some((i) => String(i.description) === a.description))
      if (relevantAssumptions.length > 0) {
        const assumptionInserts = relevantAssumptions.map((a) => {
          const match = insertedItems.find((li: Record<string, unknown>) => li.description === a.description)
          return { quote_id: quoteId, line_item_id: match?.id ?? null, description: a.message, gate: a.gate, resolution_type: null, resolved_at: null, resolved_by: null }
        })
        await supabase.from('assumptions').insert(assumptionInserts)
        unresolvedCount = relevantAssumptions.filter((a) => a.gate !== 3).length
      }
    }

    const { count: totalUnresolved } = await supabase
      .from('assumptions')
      .select('id', { count: 'exact', head: true })
      .eq('quote_id', quoteId)
      .is('resolution_type', null)

    // intake_status is deliberately not written here — it's derived (see
    // recompute_file_intake_status, migration 052) from
    // document_processing_batches.quote_id, set just below, BEFORE the
    // recompute runs, so the primary file included. The remaining fields
    // here (quote_id, intake_assumption_count, line_item_count,
    // skipped/failed_sibling_filenames, etc.) are genuinely primary-file-
    // only reporting fields — the SSE poller only ever polls the primary
    // file's row (app/api/intake/[fileId]/route.ts), so these stay scoped
    // to fileId, unlike intake_status which every consumer expects to be
    // accurate per-file.
    await supabase
      .from('files')
      .update({
        intake_stage: 'complete',
        intake_pct: 100,
        pipeline_stage: 'complete',
        quote_id: quoteId,
        intake_assumption_count: totalUnresolved ?? unresolvedCount,
        line_item_count: lineItemInserts.length,
        processing_time_ms: Date.now() - startedAt,
        failure_stage: null,
        failure_reason: null,
        // Previously computed but only ever surfaced on total failure — a
        // batch that otherwise succeeded but silently dropped one oversized
        // or unreadable document gave no indication that happened.
        skipped_sibling_filenames: skippedSiblings.length > 0 ? skippedSiblings : null,
        failed_sibling_filenames: failedToLoadSiblings.length > 0 ? failedToLoadSiblings : null,
      })
      .eq('id', fileId)

    if (parentJobId) {
      await supabase.from('document_processing_batches').update({ quote_id: quoteId, updated_at: new Date().toISOString() }).eq('id', parentJobId)
      // Every file in the batch, not just fileId (the primary/anchor) —
      // recompute_file_intake_status resolves each to 'extracted' now that
      // document_processing_batches.quote_id is set (migration 052).
      await supabase.rpc('recompute_batch_file_intake_statuses', { p_batch_id: parentJobId })
    } else {
      // Legacy direct-invocation path — no batch to derive from.
      await supabase.from('files').update({ intake_status: 'extracted' }).eq('id', fileId)
    }

    console.log(JSON.stringify({
      event: 'stage_checkpoint', job_id: jobId, batch_id: parentJobId ?? null,
      stage: 'building_quote', completed_at: new Date().toISOString(),
      documents_count: null, facts_count: facts.length,
      scope_items_count: (scopeForEstimate ?? []).length,
      quote_created: true, quote_id: quoteId, line_items_count: lineItemInserts.length,
    }))
  } catch (err) {
    console.error('estimating-engine error:', err)
    await fail(err instanceof Error ? err.message : String(err))
  } finally {
    // Always release the job-level intake lock, however this run ends —
    // early return (blocking clarifying question, a failure) or full
    // completion. Acquired by the calling Next.js route before this
    // function was invoked (see app/api/intake/[fileId]/route.ts and
    // .../clarify/route.ts) — this is the only place it's released, so a
    // second file for the same job can start once this one is genuinely
    // done rather than racing it.
    try {
      await supabase.from('job_intake_locks').delete().eq('job_id', jobId)
    } catch (lockErr) {
      console.error('Failed to release job intake lock:', lockErr)
    }
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  // Trim so a secret stored with a trailing newline/whitespace doesn't produce
  // a spurious `401 invalid x-api-key` from Anthropic.
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')?.trim()

  if (!supabaseUrl || !supabaseKey || !anthropicKey) {
    return new Response(JSON.stringify({ error: 'Missing environment variables' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  let body: { file_id?: string; job_id?: string; builder_id?: string; sibling_file_ids?: string[]; resume?: boolean; parent_job_id?: string }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const supabase = createClient(supabaseUrl, supabaseKey)
  const anthropic = new Anthropic({ apiKey: anthropicKey })

  // Document-worker mode: every document in this batch was already
  // downloaded and extracted in its own invocation (see
  // document-worker/index.ts), and this call is the exactly-once trigger
  // fired once every child job reaches a terminal state
  // (recompute_parent_batch_status in migration 034). Look up the batch to
  // recover job_id/builder_id/the primary file to report progress against
  // — the caller only needs to know parent_job_id.
  if (body.parent_job_id) {
    const { data: batch } = await supabase
      .from('document_processing_batches')
      .select('id, job_id, builder_id, primary_file_id')
      .eq('id', body.parent_job_id)
      .single()
    if (!batch) {
      return new Response(JSON.stringify({ error: 'Unknown parent_job_id' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    EdgeRuntime.waitUntil(
      runPipeline(
        { fileId: batch.primary_file_id, jobId: batch.job_id, builderId: batch.builder_id, siblingFileIds: [], resume: false, parentJobId: batch.id },
        supabase,
        anthropic
      )
    )
    return new Response(JSON.stringify({ status: 'started' }), { status: 202, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const { file_id, job_id, builder_id, sibling_file_ids, resume } = body
  if (!file_id || !job_id || !builder_id) {
    return new Response(JSON.stringify({ error: 'file_id, job_id, builder_id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  EdgeRuntime.waitUntil(
    runPipeline(
      { fileId: file_id, jobId: job_id, builderId: builder_id, siblingFileIds: Array.isArray(sibling_file_ids) ? sibling_file_ids : [], resume: resume === true },
      supabase,
      anthropic
    )
  )

  return new Response(JSON.stringify({ status: 'started' }), { status: 202, headers: { ...CORS, 'Content-Type': 'application/json' } })
})
