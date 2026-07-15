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
import { splitIntoBatches, mergeFacts, type BatchableFile, type FactRow } from './pipeline-logic.ts'
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

// cosineSimilarity now lives in ./pipeline-logic.ts (used inside mergeFacts)
// so it can be unit-tested without a Deno runtime.

// Above this similarity, two facts are treated as the same real-world fact
// restated (possibly with a different category/key label) rather than two
// distinct facts — e.g. "gross floor area: 120m2" vs "floor_area_m2: 120".
const SEMANTIC_DUPLICATE_THRESHOLD = 0.93

// Hard ceiling on how many facts get concatenated into a Stage 3/6 prompt.
// Near-duplicate merging (below) keeps real-world fact count bounded as
// documents accumulate, but this is the backstop for the case where a
// project genuinely has this many distinct facts — keep the
// highest-confidence ones (builder-answered facts are always 100) rather
// than an unbounded prompt.
const MAX_FACTS_IN_PROMPT = 200

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
  failedOut: string[]
): Promise<LoadedFile[]> {
  const { data: completedJobs } = await supabase
    .from('document_processing_jobs')
    .select('document_id, result')
    .eq('parent_job_id', parentJobId)
    .eq('status', 'completed')

  const loaded: LoadedFile[] = []
  for (const j of (completedJobs ?? []) as Array<{ document_id: string; result: PersistedExtractionResult }>) {
    const lf = await loadBlockFromExtractionResult(supabase, j.document_id, j.result)
    if (lf) loaded.push(lf)
    else failedOut.push(j.document_id)
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callTool(
  anthropic: Anthropic,
  system: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: any,
  maxTokens: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content }],
  })
  console.log(`callTool ${tool.name}: stop_reason=${response.stop_reason} usage=${JSON.stringify(response.usage)}`)
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
      .update({ intake_status: 'failed', intake_stage: 'failed', intake_pct: 0, failure_stage: 'AI_REASONING_FAILED', failure_reason: reason.slice(0, 500) })
      .eq('id', fileId)
    if (parentJobId) {
      await supabase.from('document_processing_batches').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', parentJobId)
    }
  }

  const startedAt = Date.now()

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
    const { data: existingFacts } = await supabase
      .from('project_facts')
      .select('id, category, key, value, evidence, confidence, embedding')
      .eq('job_id', jobId)
      .eq('superseded', false)

    const { data: existingDocs } = await supabase
      .from('project_documents')
      .select('id, file_id, document_type, drawing_title')
      .eq('job_id', jobId)

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
        allLoaded = await loadAllFromExtractionResults(supabase, parentJobId, failedToLoadSiblings)
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
      const { batches: fileBatches, excluded } = splitIntoBatches(batchInput, MAX_BYTES_PER_BATCH, MAX_BATCHES)
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
          ? (facts.length > MAX_FACTS_IN_PROMPT
              ? [...facts].sort((a, b) => b.confidence - a.confidence).slice(0, MAX_FACTS_IN_PROMPT)
              : facts
            ).map((f) => `- [${f.category}] ${f.key}: ${f.value}`).join('\n')
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
          docResult = await callTool(anthropic, docSystemPrompt, docUserContent, DOCUMENT_INTELLIGENCE_TOOL, 16000)
        } catch (err) {
          // A single batch's Claude call failing (a transient API error, a
          // truncated/malformed response) used to abort the ENTIRE run via
          // fail()+return — losing every fact already extracted by earlier,
          // successful batches. This is a genuinely catchable, in-band
          // failure (unlike the CPU-governor kill this pipeline separately
          // guards against above, which no catch block can intercept) — so
          // it should cost this batch's files, not the whole run. The
          // batch's files are recorded as failed and surfaced to the
          // builder exactly like a failed-to-load sibling; remaining
          // batches still get a chance to run.
          console.log(JSON.stringify({
            batch: batchIdx + 1, totalBatches: fileBatches.length,
            documents: batchFiles.map((f) => f.filename), status: 'failed',
            durationMs: Date.now() - batchStartedAt,
            error: err instanceof Error ? err.message : String(err),
          }))
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

        let insertedDocs: Array<{ id: string; file_id: string }> = []
        if (documentInserts.length > 0) {
          const { data } = await supabase.from('project_documents').upsert(documentInserts, { onConflict: 'file_id' }).select('id, file_id')
          insertedDocs = data ?? []
        }
        const fileIdToDocId = new Map(insertedDocs.map((d) => [d.file_id, d.id]))
        for (const d of docRows) {
          const title = (d.drawing_title as string) ?? (d.document_type as string)
          if (title) processedDocTitles.push(title)
        }

        // Persist Stage 2 — new facts (this batch), merged against both
        // pre-existing DB facts and facts extracted by earlier batches in
        // this same run (facts, kept up to date after every batch below).
        const factRows = (docResult.facts ?? []) as Array<Record<string, unknown>>
        const factInsertsBase = factRows.map((f) => ({
          job_id: jobId,
          category: f.category as string,
          key: f.key as string,
          value: String(f.value),
          source_document_id: typeof f.source_file_index === 'number' ? (fileIdToDocId.get(realFileId(fileIndexToId[f.source_file_index as number])) ?? null) : null,
          page_reference: (f.page_reference as string) ?? null,
          evidence: (f.evidence as string) ?? null,
          confidence: (f.confidence as number) ?? 70,
        }))

        if (factInsertsBase.length > 0) {
          // P2: embed each new fact's text for semantic near-duplicate
          // detection, best-effort — see embedTexts above. Voyage bills per
          // call, so this is one batched request per document batch.
          const voyageApiKey = Deno.env.get('VOYAGE_API_KEY')
          const factTexts = factInsertsBase.map((f) => `[${f.category}] ${f.key}: ${f.value}`)
          const embeddings = await embedTexts(factTexts, voyageApiKey)
          const factInserts: FactRow[] = factInsertsBase.map((f, i) => ({ ...f, embedding: embeddings[i] }))

          // Auto-supersede: a new fact for the same job_id + category + key
          // with a different value replaces the prior one instead of both
          // accumulating forever, or (below the exact-key check) a semantic
          // near-duplicate under a different label — see mergeFacts. Merges
          // against `facts`, which already includes both DB-persisted facts
          // and anything extracted by earlier batches in this run.
          const merge = mergeFacts(facts, factInserts, SEMANTIC_DUPLICATE_THRESHOLD)

          if (merge.supersededIds.length > 0) {
            await supabase.from('project_facts').update({ superseded: true }).in('id', merge.supersededIds)
          }
          const { data: insertedFactRows } = await supabase.from('project_facts').insert(factInserts).select('id')
          const insertedIds = (insertedFactRows ?? []).map((r: Record<string, unknown>) => r.id as string)

          facts = [
            ...facts.filter((f) => !merge.supersededKeys.includes(`${f.category}::${f.key}`)),
            ...factInserts.map((f, i) => ({ ...f, id: insertedIds[i] })),
          ]
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

    // ── Stage 3 + 4: Scope Reasoning + Gap Detection ───────────────────────
    await setStage('reasoning_scope')

    // Near-duplicate merging above keeps real-world fact count bounded as
    // documents accumulate; this is the backstop for a project that
    // genuinely has more distinct facts than that — keep the
    // highest-confidence ones rather than an unbounded prompt.
    const factsForPrompt = facts.length > MAX_FACTS_IN_PROMPT
      ? [...facts].sort((a, b) => b.confidence - a.confidence).slice(0, MAX_FACTS_IN_PROMPT)
      : facts

    const factsBlock = factsForPrompt.map((f) => `- [${f.category}] ${f.key}: ${f.value} (confidence ${f.confidence}%${f.evidence ? `, evidence: ${f.evidence}` : ''})`).join('\n')

    const scopeSystemPrompt = `You are a senior Australian residential construction estimator. Reason about scope like an experienced estimator would — combine evidence across documents rather than treating each fact in isolation. For each relevant trade, state what is included, what is excluded, dependencies, and assumptions. Only raise a clarifying question when missing information would materially change scope or quantities for a trade — most small gaps should NOT be questions, they get handled later as per-line assumptions. Keep total questions minimal and only mark "blocking" when the estimate genuinely cannot proceed responsibly without an answer (e.g. a double-storey addition with no structural drawings at all).${memoryContext}`

    const scopeUserContent = [{ type: 'text' as const, text: `PROJECT FACTS:\n${factsBlock}\n\nTrade categories:\n${TRADE_CATEGORIES.map((c) => `${c.id}. ${c.name}`).join('\n')}\n\nUse the reason_about_scope tool.` }]

    const scopeStartedAt = Date.now()
    let scopeResult: { scope?: unknown[]; clarifying_questions?: unknown[] } | null = null
    try {
      // Was 4096, then 8192 -- both truncated (confirmed via stop_reason log)
      // on a real 75-fact project reasoning across 13 trades. Match the other
      // two stages' proven 16000 rather than guessing at yet another cap.
      scopeResult = await callTool(anthropic, scopeSystemPrompt, scopeUserContent, SCOPE_REASONING_TOOL, 16000)
    } catch (err) {
      console.log(JSON.stringify({ stage: 'reasoning_scope', status: 'failed', durationMs: Date.now() - scopeStartedAt, factsInPrompt: factsForPrompt.length, error: err instanceof Error ? err.message : String(err) }))
      await fail(`Scope reasoning call failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!scopeResult) { await fail('No structured response from scope reasoning stage'); return }
    console.log(JSON.stringify({ stage: 'reasoning_scope', status: 'processed', durationMs: Date.now() - scopeStartedAt, factsInPrompt: factsForPrompt.length, tradesReasoned: (scopeResult.scope ?? []).length, questionsRaised: (scopeResult.clarifying_questions ?? []).length }))

    await setStage('detecting_gaps')

    const scopeRows = (scopeResult.scope ?? []) as Array<Record<string, unknown>>
    if (scopeRows.length > 0) {
      const scopeInserts = scopeRows
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
      if (scopeInserts.length > 0) {
        await supabase.from('scope_items').upsert(scopeInserts, { onConflict: 'job_id,trade_category_id' })
      }
    }

    const questions = ((scopeResult.clarifying_questions ?? []) as Array<Record<string, unknown>>)
    const blockingQuestions = questions.filter((q) => q.blocking === true)

    if (blockingQuestions.length > 0) {
      const questionInserts = blockingQuestions.map((q) => ({
        job_id: jobId,
        question: q.question,
        reason: q.reason,
        trade_category_id: q.trade_category_id ?? null,
        blocking: true,
        status: 'open' as const,
      }))
      await supabase.from('clarifying_questions').insert(questionInserts)

      await supabase
        .from('files')
        .update({ intake_status: 'needs_info', intake_stage: 'awaiting_clarification', intake_pct: STAGES.awaiting_clarification, pipeline_stage: 'awaiting_clarification' })
        .eq('id', fileId)
      return
    }

    // Non-blocking questions are logged for visibility but never stop the pipeline.
    const nonBlocking = questions.filter((q) => q.blocking !== true)
    if (nonBlocking.length > 0) {
      await supabase.from('clarifying_questions').insert(
        nonBlocking.map((q) => ({
          job_id: jobId, question: q.question, reason: q.reason,
          trade_category_id: q.trade_category_id ?? null, blocking: false, status: 'open' as const,
        }))
      )
    }

    // ── Stage 6: Estimate Generation (spec Stage 5) ────────────────────────
    await setStage('generating_estimate')

    const { data: scopeForEstimate } = await supabase
      .from('scope_items')
      .select('trade_category_id, included_scope, excluded_scope, assumptions, uncertainty_notes')
      .eq('job_id', jobId)

    const scopeBlock = (scopeForEstimate ?? [])
      .map((s: Record<string, unknown>) => `Trade ${s.trade_category_id} (${TRADE_CATEGORIES.find((t) => t.id === s.trade_category_id)?.name}): included = ${(s.included_scope as string[]).join('; ')}. excluded = ${(s.excluded_scope as string[]).join('; ')}.`)
      .join('\n')

    const estimateSystemPrompt = `You are a senior Australian residential quantity surveyor producing a full construction cost takeoff. Base every quantity on the project facts and scope below — never invent a quantity or a material. When a quantity cannot be derived from anything provided, set manual_input_required = true and leave quantity/unit null rather than guessing. Produce a complete takeoff across all in-scope trades (typically 80-250 line items for a full residential project — fewer for a small job, do not pad to hit a number). Use Australian units only (m2, lm, m3, each, lot, weeks, hours). Descriptions must be specific ("Concrete slab — 125mm ground floor", not "Concrete"). Set pricing_type: measured (derived from a dimension/schedule), pc_allowance (prime cost item), or provisional_sum (scope TBD by others). If the source documents are themselves a priced estimate/BOQ, extract the printed unit rate and line total into document_rate/document_total as COST figures (exclude margin and GST) — otherwise leave them null so the platform's rate engine can price the line.`

    const estimateUserContent = [{ type: 'text' as const, text: `PROJECT FACTS:\n${factsBlock}\n\nSCOPE REASONING:\n${scopeBlock}\n\nUse the generate_estimate tool.` }]

    const estimateStartedAt = Date.now()
    let estimateResult: { line_items?: unknown[] } | null = null
    try {
      estimateResult = await callTool(anthropic, estimateSystemPrompt, estimateUserContent, ESTIMATE_GENERATION_TOOL, 16000)
    } catch (err) {
      console.log(JSON.stringify({ stage: 'generating_estimate', status: 'failed', durationMs: Date.now() - estimateStartedAt, error: err instanceof Error ? err.message : String(err) }))
      await fail(`Estimate generation call failed: ${err instanceof Error ? err.message : String(err)}`)
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

    const rawItems = estimateResult.line_items as Array<Record<string, unknown>>
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

    await supabase
      .from('files')
      .update({
        intake_status: 'extracted',
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
    }
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
