#!/usr/bin/env node
// ============================================================
// WorkA — developer-mode, single-process estimate generator
// ============================================================
// PURPOSE: prove the product can turn real uploaded documents into a priced
// estimate at all. Nothing else. This intentionally bypasses every piece of
// production hardening built around the pipeline (document-worker's queue,
// job_intake_locks, MAX_BATCHES bin-packing, Stage 3 trade-chunking,
// wall-clock budgeting, the intake-recovery cron, AI failure classification
// / retry) — none of that has ever been exercised against a pipeline that
// has produced zero real estimates. Get one estimate first; then those
// systems have something real to protect.
//
// This script is NOT a Supabase Edge Function and is NOT invoked over HTTP
// — it's a plain, long-running Node process with no CPU-time governor and
// no ~400s isolate wall-clock ceiling, so it can afford to do the whole
// pipeline as 3 sequential Claude calls with no chunking/batching at all.
//
// Reuses real, dependency-free application code rather than re-implementing
// pricing/gating: lib/pricing.ts (ensureQuotePriced, the same 5-tier rate
// resolution the rest of the app uses) and lib/estimating/gates.ts (the
// canonical Gate 1/2/3 spec) are imported directly via a relative, .ts
// import under --experimental-strip-types — the same cross-runtime-import
// pattern scripts/backfill-project-models.mjs and lib/project-context.test.ts
// already use. Nothing about pricing or gating is reinvented here.
//
// The Claude tool schemas below are deliberately a copy of
// supabase/functions/smooth-responder/index.ts's DOCUMENT_INTELLIGENCE_TOOL
// / SCOPE_REASONING_TOOL / ESTIMATE_GENERATION_TOOL, not an import — that
// file is a Deno Edge Function (`Deno.serve(...)` at module scope), so
// importing it here would execute that handler in Node and crash. Keep
// these schemas in sync by hand if the real pipeline's schemas change;
// they don't need to be byte-identical, only compatible with the same DB
// columns.
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ANTHROPIC_API_KEY=... \
//     node --experimental-strip-types scripts/dev-generate-estimate.mjs \
//       --builder-id=<uuid> \
//       --address="16 Alfred St, Woonona" \
//       --files=/path/to/1.pdf,/path/to/2.pdf,...
//
//   Or against an existing job (reuses it, does not create a new one):
//       --job-id=<uuid> --files=...
//
// Prints a JSON summary at the end: quote_id, total_cost, confidence_score,
// line_item_count, unresolved_assumption_count.
// ============================================================

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { ensureQuotePriced } from '../lib/pricing.ts'
import { applyValidationGates } from '../lib/estimating/gates.ts'
import { tradeCategoryName } from '../lib/trade-taxonomy.ts'

// ─── CLI args ────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=')
    return [k, rest.join('=')]
  })
)

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim()

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ANTHROPIC_API_KEY')
  process.exit(1)
}
if (!args['builder-id']) {
  console.error('Required: --builder-id=<uuid>')
  process.exit(1)
}
if (!args['job-id'] && !args.address) {
  console.error('Required: either --job-id=<uuid> (existing job) or --address="..." (creates a new job)')
  process.exit(1)
}
// --skip-to=stage6 reuses facts/scope_items already persisted for --job-id
// (from a prior run that got through Stage 1/2 + Stage 3 successfully) and
// jumps straight to Stage 6 — no need to re-spend ~10 minutes of Claude
// calls just to retry estimate generation alone.
const skipToStage6 = args['skip-to'] === 'stage6'
if (skipToStage6 && !args['job-id']) {
  console.error('--skip-to=stage6 requires --job-id=<uuid> of a job that already has facts + scope_items persisted')
  process.exit(1)
}
if (!skipToStage6 && !args.files) {
  console.error('Required: --files=/path/a.pdf,/path/b.pdf,... (or --skip-to=stage6 with --job-id to reuse an existing run\'s facts/scope)')
  process.exit(1)
}

const filePaths = args.files ? args.files.split(',').map((p) => p.trim()).filter(Boolean) : []
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

const MODEL = 'claude-sonnet-4-6'

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

// ─── Tool schemas (copies — see header comment) ────────────────────────────

const DOCUMENT_INTELLIGENCE_TOOL = {
  name: 'analyse_project_documents',
  description: 'Return the document map (Stage 1) and the evidence-backed project fact base (Stage 2).',
  input_schema: {
    type: 'object',
    properties: {
      documents: {
        type: 'array',
        description: 'One entry per document provided, in the same order.',
        items: {
          type: 'object',
          properties: {
            file_index: { type: 'integer' },
            document_type: { type: 'string' },
            discipline: { type: 'string' },
            drawing_title: { type: ['string', 'null'] },
            readability: { type: 'string', enum: ['clear', 'partial', 'poor'] },
            notes: { type: ['string', 'null'] },
          },
          required: ['file_index', 'document_type', 'readability'],
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
            key: { type: 'string' },
            value: { type: 'string' },
            source_file_index: { type: ['integer', 'null'] },
            page_reference: { type: ['string', 'null'] },
            evidence: { type: 'string' },
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
  description: 'Return per-trade scope reasoning (Stage 3) for every trade actually relevant to this project. Only 13 trade_category_id values exist (1-13); use only those you have real evidence for.',
  input_schema: {
    type: 'object',
    properties: {
      scope: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            trade_category_id: { type: 'integer', minimum: 1, maximum: 13 },
            included_scope: { type: 'array', items: { type: 'string' } },
            excluded_scope: { type: 'array', items: { type: 'string' } },
            assumptions: { type: 'array', items: { type: 'string' } },
            uncertainty_notes: { type: ['string', 'null'] },
            confidence: { type: 'integer', minimum: 0, maximum: 100 },
          },
          required: ['trade_category_id', 'included_scope', 'excluded_scope', 'confidence'],
        },
      },
    },
    required: ['scope'],
  },
}

const ESTIMATE_GENERATION_TOOL = {
  name: 'generate_estimate',
  description: 'Return the full line-item takeoff for the project.',
  input_schema: {
    type: 'object',
    properties: {
      line_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            trade_category_id: { type: 'integer', minimum: 1, maximum: 13 },
            description: { type: 'string' },
            quantity: { type: ['number', 'null'] },
            unit: { type: ['string', 'null'] },
            dimensions_string: { type: ['string', 'null'] },
            confidence: { type: 'integer', minimum: 0, maximum: 100 },
            pricing_type: { type: 'string', enum: ['measured', 'pc_allowance', 'provisional_sum'] },
            source_ref: { type: ['string', 'null'] },
            manual_input_required: { type: 'boolean' },
            document_rate: { type: ['number', 'null'], description: 'ONLY set if a source document (a priced schedule, BOQ, or fixtures/finishes selection sheet) itself prints a unit COST for this exact item — e.g. a fittings/finishes schedule row with a supplier $ figure, or a category subtotal from such a schedule. Exclude margin and GST. This is the single most important field for PC allowance / provisional sum items and anything from a priced selection schedule — prefer it over leaving pricing_type items unpriced.' },
            document_total: { type: ['number', 'null'], description: 'ONLY set if a source document prints a line/category COST TOTAL for this item (e.g. a fittings schedule category subtotal like "Showers+Tapware+Waste $27,043"). Exclude margin and GST.' },
          },
          required: ['trade_category_id', 'description', 'confidence', 'pricing_type', 'manual_input_required'],
        },
      },
    },
    required: ['line_items'],
  },
}

// Copy of smooth-responder/index.ts's deriveDocPrice — when a source
// document itself prints a cost (a priced schedule/BOQ/selection sheet),
// use it directly instead of the 5-tier cost_rates lookup, which has no
// entry for a specific product/brand/custom item. Missing this was
// confirmed to badly undercount a real fitout-heavy project's total.
function deriveDocPrice(rate, total, quantity) {
  const r = typeof rate === 'number' && isFinite(rate) && rate > 0 ? rate : null
  const t = typeof total === 'number' && isFinite(total) && total > 0 ? total : null
  if (r === null && t === null) return { rate: null, total: null }
  const qty = quantity !== null && quantity > 0 ? quantity : null
  let derivedTotal = t ?? (r !== null && qty !== null ? Math.round(r * qty * 100) / 100 : r)
  let derivedRate = r ?? (t !== null && qty !== null ? Math.round((t / qty) * 100) / 100 : t)
  if (derivedRate === null) derivedRate = derivedTotal
  if (derivedTotal === null) derivedTotal = derivedRate
  return { rate: derivedRate, total: derivedTotal }
}

async function callTool(system, content, tool, maxTokens = 16000) {
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  })
  log('claude_call_complete', {
    tool: tool.name, stop_reason: resp.stop_reason,
    output_tokens: resp.usage?.output_tokens ?? null, input_tokens: resp.usage?.input_tokens ?? null,
    max_tokens: maxTokens,
  })
  if (resp.stop_reason === 'max_tokens') {
    log('claude_call_truncated_warning', {
      tool: tool.name,
      message: 'Response hit max_tokens before finishing — output below may be incomplete or unparseable. Re-run with a higher maxTokens for this call.',
    })
  }
  const toolUse = resp.content.find((b) => b.type === 'tool_use')
  if (!toolUse) throw new Error(`No tool_use block returned for ${tool.name} (stop_reason: ${resp.stop_reason})`)
  return toolUse.input
}

async function main() {
  // ── Job ────────────────────────────────────────────────────────────────
  let jobId = args['job-id']
  const builderId = args['builder-id']
  if (!jobId) {
    const { data: job, error } = await supabase
      .from('jobs')
      .insert({ builder_id: builderId, address: args.address, status: 'quoting' })
      .select('id')
      .single()
    if (error) throw new Error(`Could not create job: ${error.message}`)
    jobId = job.id
  }
  log('job_ready', { job_id: jobId })

  let factInserts
  let scopeInserts
  let factsBlock

  if (skipToStage6) {
    const { data: existingFacts, error: factsErr } = await supabase
      .from('project_facts')
      .select('category, key, value, evidence, confidence')
      .eq('job_id', jobId)
      .eq('superseded', false)
    if (factsErr) throw new Error(`Could not load existing project_facts: ${factsErr.message}`)
    const { data: existingScope, error: scopeErr } = await supabase
      .from('scope_items')
      .select('trade_category_id, included_scope, excluded_scope, assumptions, uncertainty_notes, confidence')
      .eq('job_id', jobId)
    if (scopeErr) throw new Error(`Could not load existing scope_items: ${scopeErr.message}`)
    factInserts = existingFacts ?? []
    scopeInserts = existingScope ?? []
    if (factInserts.length === 0) throw new Error(`--skip-to=stage6 but job ${jobId} has no persisted project_facts — run without --skip-to first`)
    if (scopeInserts.length === 0) throw new Error(`--skip-to=stage6 but job ${jobId} has no persisted scope_items — run without --skip-to first`)
    factsBlock = factInserts.map((f) => `[${f.category}] ${f.key}: ${f.value} (confidence ${f.confidence}%, evidence: ${f.evidence ?? 'n/a'})`).join('\n')
    log('skipped_to_stage6', { job_id: jobId, facts: factInserts.length, trades: scopeInserts.length })
  } else {

  // ── Load documents, create `files` rows (dev mode: bypasses Storage —
  // real production upload writes storage_path via /api/upload; here we
  // read straight off local disk and record a placeholder path since
  // nothing downstream in this script reads it back from Storage) ────────
  const docs = []
  for (const p of filePaths) {
    const bytes = readFileSync(p)
    const filename = basename(p)
    const { data: fileRow, error } = await supabase
      .from('files')
      .insert({
        job_id: jobId, builder_id: builderId, filename,
        storage_path: `dev-mode/${jobId}/${filename}`,
        file_type: 'pdf', intake_status: 'extracted',
      })
      .select('id')
      .single()
    if (error) throw new Error(`Could not create files row for ${filename}: ${error.message}`)
    docs.push({ fileId: fileRow.id, filename, base64: bytes.toString('base64') })
  }
  log('documents_loaded', { job_id: jobId, count: docs.length, files: docs.map((d) => d.filename) })

  // ── Stage 1+2: Document Intelligence + Project Understanding ───────────
  // Size-bounded batching only — no MAX_BATCHES cap, no wall-clock budget,
  // no queue. A single Claude request has a hard ~32MB body limit; base64
  // inflates raw bytes by ~33%, so we bin-pack documents into batches under
  // a conservative 15MB-of-raw-bytes budget (comfortably under the cap once
  // base64 + JSON overhead is added) and just call Stage 1/2 once per
  // batch, sequentially, in this same process. No parallelism, no retry —
  // if one batch's call fails, the whole script fails loudly, which is the
  // point right now.
  const MAX_RAW_BYTES_PER_BATCH = 15 * 1024 * 1024
  const batches = []
  let current = []
  let currentBytes = 0
  for (const d of docs) {
    const bytes = Buffer.byteLength(d.base64, 'base64')
    if (current.length > 0 && currentBytes + bytes > MAX_RAW_BYTES_PER_BATCH) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(d)
    currentBytes += bytes
  }
  if (current.length > 0) batches.push(current)
  log('stage12_batches_planned', { job_id: jobId, batch_count: batches.length, batch_sizes: batches.map((b) => b.length) })

  const stage12System = 'You are a senior Australian residential construction estimator analysing project documents. Extract only what you can point to direct evidence for — never invent a fact. Use the analyse_project_documents tool.'
  const allDocInserts = []
  const allFactInserts = []
  for (const [batchIdx, batchDocs] of batches.entries()) {
    const stage12Content = [
      ...batchDocs.map((d) => ({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: d.base64 },
      })),
      { type: 'text', text: `Documents are indexed 0-${batchDocs.length - 1} in the order given (file_index). Use the analyse_project_documents tool.` },
    ]
    log('stage12_calling', { job_id: jobId, batch: batchIdx + 1, of: batches.length, document_count: batchDocs.length })
    const stage12 = await callTool(stage12System, stage12Content, DOCUMENT_INTELLIGENCE_TOOL)

    // Dedupe by file_index, keep the first — project_documents.file_id is
    // UNIQUE (one classification row per uploaded file), but Claude can
    // return more than one "documents" entry for the same file_index (e.g.
    // a multi-page/multi-sheet PDF it treats as several logical drawings).
    // The simplified dev-mode schema doesn't ask it to dedupe that itself
    // the way the real pipeline's is_duplicate/superseded fields do.
    const seenFileIndexes = new Set()
    const docInserts = (stage12.documents ?? [])
      .filter((d) => typeof d.file_index === 'number' && batchDocs[d.file_index])
      .filter((d) => {
        if (seenFileIndexes.has(d.file_index)) return false
        seenFileIndexes.add(d.file_index)
        return true
      })
      .map((d) => ({
        job_id: jobId, file_id: batchDocs[d.file_index].fileId,
        document_type: d.document_type ?? null, discipline: d.discipline ?? null,
        drawing_title: d.drawing_title ?? null, readability: d.readability ?? null,
        notes: d.notes ?? null,
      }))
    if (docInserts.length > 0) {
      const { error } = await supabase.from('project_documents').insert(docInserts)
      if (error) throw new Error(`Could not persist project_documents (batch ${batchIdx + 1}): ${error.message}`)
    }
    allDocInserts.push(...docInserts)

    const factInserts = (stage12.facts ?? []).map((f) => ({
      job_id: jobId, category: f.category, key: f.key, value: String(f.value),
      page_reference: f.page_reference ?? null, evidence: f.evidence ?? null,
      confidence: f.confidence ?? 70,
    }))
    if (factInserts.length > 0) {
      const { error: factErr } = await supabase.from('project_facts').insert(factInserts)
      if (factErr) throw new Error(`Could not persist project_facts (batch ${batchIdx + 1}): ${factErr.message}`)
    }
    allFactInserts.push(...factInserts)
    log('stage12_batch_done', { job_id: jobId, batch: batchIdx + 1, documents: docInserts.length, facts: factInserts.length })
  }

  const docInserts = allDocInserts
  factInserts = allFactInserts
  if (factInserts.length === 0) throw new Error('Stage 1/2 returned zero facts — nothing to reason about. Stop here and inspect the documents/prompt, not the pipeline.')
  log('stage12_done', { job_id: jobId, documents: docInserts.length, facts: factInserts.length })

  // ── Stage 3: Scope Reasoning — all 13 trades in one call, no chunking ──
  factsBlock = factInserts.map((f) => `[${f.category}] ${f.key}: ${f.value} (confidence ${f.confidence}%, evidence: ${f.evidence ?? 'n/a'})`).join('\n')
  const stage3System = 'You are a senior Australian residential construction estimator. Reason about scope like an experienced estimator would — combine evidence across documents rather than treating each fact in isolation. For each relevant trade, state what is included, what is excluded, and assumptions. Use the reason_about_scope tool.'
  const stage3Content = [{ type: 'text', text: `PROJECT FACTS:\n${factsBlock}\n\nReason about every trade actually relevant to this project (trade_category_id 1-13). Use the reason_about_scope tool.` }]
  log('stage3_calling', { job_id: jobId, facts_in_prompt: factInserts.length })
  const stage3 = await callTool(stage3System, stage3Content, SCOPE_REASONING_TOOL)

  scopeInserts = (stage3.scope ?? [])
    .filter((s) => typeof s.trade_category_id === 'number')
    .map((s) => ({
      job_id: jobId, trade_category_id: s.trade_category_id,
      included_scope: s.included_scope ?? [], excluded_scope: s.excluded_scope ?? [],
      assumptions: s.assumptions ?? [], uncertainty_notes: s.uncertainty_notes ?? null,
      confidence: s.confidence ?? null,
    }))
  if (scopeInserts.length === 0) throw new Error('Stage 3 returned zero trades — stop here, do not proceed to estimating on nothing.')
  const { error: stage3PersistErr } = await supabase.from('scope_items').upsert(scopeInserts, { onConflict: 'job_id,trade_category_id' })
  if (stage3PersistErr) throw new Error(`Could not persist scope_items: ${stage3PersistErr.message}`)
  log('stage3_done', { job_id: jobId, trades: scopeInserts.length })

  } // end of !skipToStage6 block

  // ── Stage 6: Estimate Generation (quantities only, no rates yet) ───────
  // Bug fix (nothing else changed in this stage): the trade NAME was never
  // included here, only the bare numeric trade_category_id — Stage 6 had no
  // way to know what "Trade 3" or "Trade 5" actually means and was
  // observed misfiling real scope (framing, plasterboard) under wrong
  // trades as a result. Production's real smooth-responder/index.ts
  // (its own scopeBlock, ~line 2180) has always included the name; this
  // dev script's copy simply omitted it. Format matches production exactly:
  // `Trade {id} ({name}): included = ...`.
  const scopeBlock = scopeInserts.map((s) => `Trade ${s.trade_category_id} (${tradeCategoryName(s.trade_category_id)}): included=${JSON.stringify(s.included_scope)}, excluded=${JSON.stringify(s.excluded_scope)}, assumptions=${JSON.stringify(s.assumptions)}`).join('\n')
  const stage6System = 'You are a senior Australian residential quantity surveyor producing a full construction cost takeoff. Base every quantity on the facts and scope below — never invent a quantity or a material. When a quantity cannot be derived from anything provided, set manual_input_required = true and leave quantity/unit null rather than guessing. Use Australian units only (m2, lm, m3, each, lot, weeks, hours). IMPORTANT: if any of the underlying facts came from a priced document (a fittings/finishes/fixtures schedule, a BOQ, a supplier quote) that stated an actual dollar figure — a per-unit rate, a line total, or a category subtotal — set document_rate or document_total on that line item to that real figure instead of leaving it unpriced. This is the primary way PC allowance and provisional sum items should get a value; prefer using a real printed figure over manual_input_required whenever the facts contain one. Use the generate_estimate tool.'
  const stage6Content = [{ type: 'text', text: `PROJECT FACTS:\n${factsBlock}\n\nSCOPE:\n${scopeBlock}\n\nUse the generate_estimate tool.` }]
  log('stage6_calling', { job_id: jobId })
  // Higher ceiling than Stage 1/2 and Stage 3 — this is the stage producing
  // the most output (potentially 100+ line items across 13 trades), and
  // 16000 (production's proven-safe value for its own, similarly-sized
  // prompts) came back with zero items on a real 152-fact, 13-trade run
  // here. Raised, not investigated further yet — claude_call_complete above
  // logs stop_reason/output_tokens on every call, so if this still comes
  // back empty the log will show whether it's genuinely a max_tokens cutoff
  // (stop_reason: 'max_tokens') or something else entirely.
  // Confirmed on a real run (200 facts, 13 trades): 32000 still hit
  // stop_reason 'max_tokens' with output_tokens:32000 exactly, zero usable
  // line items recovered. Claude Sonnet 4.x supports up to 64000 output
  // tokens without any beta header — try that ceiling before considering a
  // per-trade-chunked Stage 6 (more invasive, not needed yet).
  const stage6 = await callTool(stage6System, stage6Content, ESTIMATE_GENERATION_TOOL, 64000)
  const rawItems = stage6.line_items ?? []
  if (rawItems.length === 0) throw new Error('Stage 6 returned zero line items — stop here.')

  // ── Gates (reused, not reimplemented — lib/estimating/gates.ts) ────────
  const validated = rawItems
    .filter((item) => typeof item.trade_category_id === 'number' && item.trade_category_id >= 1 && item.trade_category_id <= 13)
    .map((item) => {
      const docPrice = deriveDocPrice(item.document_rate, item.document_total, item.quantity ?? null)
      const gateResult = applyValidationGates({
        description: String(item.description ?? ''),
        quantity: item.quantity ?? null,
        unit: item.unit ?? null,
        dimensions_string: item.dimensions_string ?? null,
        pricing_type: item.pricing_type ?? 'measured',
        has_document_price: docPrice.total !== null,
      })
      return { ...item, ...gateResult, _docRate: docPrice.rate, _docTotal: docPrice.total }
    })
  const docPricedCount = validated.filter((i) => i._docTotal !== null).length
  log('document_pricing_applied', { job_id: jobId, items_with_document_price: docPricedCount, items_total: validated.length })

  // ── Quote ────────────────────────────────────────────────────────────
  const { data: quoteRow, error: quoteErr } = await supabase
    .from('quotes')
    .insert({ job_id: jobId, builder_id: builderId, status: 'draft', total_cost: null, margin_pct: null, confidence_score: null, version: 1 })
    .select('id')
    .single()
  if (quoteErr) throw new Error(`Could not create quote: ${quoteErr.message}`)
  const quoteId = quoteRow.id

  const lineItemInserts = validated
    .filter((item) => item.assumption_status !== 'excluded')
    .map((item) => ({
      quote_id: quoteId, trade_category_id: item.trade_category_id, description: item.description,
      quantity: item.manual_input_required ? null : (item.quantity ?? null),
      unit: item.manual_input_required ? null : (item.unit ?? null),
      // Document-sourced price (a real figure Claude read off a priced
      // schedule/BOQ) wins outright — never overwritten by the 5-tier
      // cost_rates lookup later (ensureQuotePriced only touches items whose
      // rate is still null, see lib/pricing.ts's own `unpriced` filter).
      rate: item._docRate ?? null, total: item._docTotal ?? null,
      confidence: item.confidence ?? 50, dimensions_string: item.dimensions_string ?? null,
      is_assumption: item.is_assumption ?? false, assumption_status: item.assumption_status ?? null,
      // quote_line_items.source_ref is varchar(100) — Claude occasionally
      // writes a longer note here instead of a short drawing reference
      // ("A3.1"). Truncate rather than reject the whole insert over one
      // field on one line item (confirmed on a real run: this alone failed
      // an otherwise-good 60+ item takeoff).
      pricing_type: item.pricing_type ?? 'measured',
      source_ref: item.source_ref ? String(item.source_ref).slice(0, 100) : null,
      margin_pct: item.pricing_type === 'provisional_sum' ? 0 : 0.15,
    }))
  const { data: insertedItems, error: liErr } = await supabase
    .from('quote_line_items')
    .insert(lineItemInserts)
    .select('id, description')
  if (liErr) throw new Error(`Could not persist quote_line_items: ${liErr.message}`)
  log('stage6_done', { job_id: jobId, quote_id: quoteId, line_items: insertedItems.length })

  // Assumptions rows for gated items — keeps AssumptionReview/quote UI honest
  const assumptionInserts = validated
    .filter((item) => item.gate)
    .map((item) => {
      const match = insertedItems.find((li) => li.description === item.description)
      return { quote_id: quoteId, line_item_id: match?.id ?? null, description: item.message, gate: item.gate, resolution_type: null }
    })
  if (assumptionInserts.length > 0) {
    await supabase.from('assumptions').insert(assumptionInserts)
  }

  // ── Pricing — reused, not reimplemented (lib/pricing.ts, 5-tier rates) ─
  const priced = await ensureQuotePriced(supabase, quoteId)
  log('pricing_done', { job_id: jobId, quote_id: quoteId, priced })

  const { data: finalQuote } = await supabase
    .from('quotes')
    .select('id, total_cost, confidence_score, margin_pct')
    .eq('id', quoteId)
    .single()

  // Coverage, not just a total — a dollar figure with no visible sense of
  // how much of the scope it actually reflects is exactly what produced a
  // silently-25x-too-low number on the first real run through this script
  // (71% of line items unpriced, and the total looked like a normal
  // number regardless). Query the real persisted state rather than
  // trusting in-memory counts, since ensureQuotePriced ran since.
  const { data: allFinalItems } = await supabase
    .from('quote_line_items')
    .select('total, assumption_status')
    .eq('quote_id', quoteId)
  const includedItems = (allFinalItems ?? []).filter((i) => i.assumption_status !== 'excluded')
  const pricedItems = includedItems.filter((i) => i.total !== null)
  const unpricedCount = includedItems.length - pricedItems.length
  const coveragePct = includedItems.length > 0 ? Math.round((pricedItems.length / includedItems.length) * 100) : 0

  console.log(JSON.stringify({
    event: 'estimate_complete',
    job_id: jobId,
    quote_id: quoteId,
    total_cost: finalQuote?.total_cost ?? null,
    confidence_score: finalQuote?.confidence_score ?? null,
    line_item_count: insertedItems.length,
    unresolved_assumption_count: assumptionInserts.filter((a) => a.gate !== 3).length,
    priced_line_items: pricedItems.length,
    unpriced_line_items: unpricedCount,
    price_coverage_pct: coveragePct,
    warning: coveragePct < 90
      ? `Only ${coveragePct}% of line items have a price — total_cost reflects that partial coverage, NOT the full project scope. Treat this total as a floor, not a real estimate, until unpriced/unresolved items are addressed.`
      : null,
  }, null, 2))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'dev_estimate_failed', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
