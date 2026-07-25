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
if (!args.files) {
  console.error('Required: --files=/path/a.pdf,/path/b.pdf,...')
  process.exit(1)
}

const filePaths = args.files.split(',').map((p) => p.trim()).filter(Boolean)
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
          },
          required: ['trade_category_id', 'description', 'confidence', 'pricing_type', 'manual_input_required'],
        },
      },
    },
    required: ['line_items'],
  },
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

    const docInserts = (stage12.documents ?? [])
      .filter((d) => typeof d.file_index === 'number' && batchDocs[d.file_index])
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
  const factInserts = allFactInserts
  if (factInserts.length === 0) throw new Error('Stage 1/2 returned zero facts — nothing to reason about. Stop here and inspect the documents/prompt, not the pipeline.')
  log('stage12_done', { job_id: jobId, documents: docInserts.length, facts: factInserts.length })

  // ── Stage 3: Scope Reasoning — all 13 trades in one call, no chunking ──
  const factsBlock = factInserts.map((f) => `[${f.category}] ${f.key}: ${f.value} (confidence ${f.confidence}%, evidence: ${f.evidence ?? 'n/a'})`).join('\n')
  const stage3System = 'You are a senior Australian residential construction estimator. Reason about scope like an experienced estimator would — combine evidence across documents rather than treating each fact in isolation. For each relevant trade, state what is included, what is excluded, and assumptions. Use the reason_about_scope tool.'
  const stage3Content = [{ type: 'text', text: `PROJECT FACTS:\n${factsBlock}\n\nReason about every trade actually relevant to this project (trade_category_id 1-13). Use the reason_about_scope tool.` }]
  log('stage3_calling', { job_id: jobId, facts_in_prompt: factInserts.length })
  const stage3 = await callTool(stage3System, stage3Content, SCOPE_REASONING_TOOL)

  const scopeInserts = (stage3.scope ?? [])
    .filter((s) => typeof s.trade_category_id === 'number')
    .map((s) => ({
      job_id: jobId, trade_category_id: s.trade_category_id,
      included_scope: s.included_scope ?? [], excluded_scope: s.excluded_scope ?? [],
      assumptions: s.assumptions ?? [], uncertainty_notes: s.uncertainty_notes ?? null,
      confidence: s.confidence ?? null,
    }))
  if (scopeInserts.length === 0) throw new Error('Stage 3 returned zero trades — stop here, do not proceed to estimating on nothing.')
  const { error: scopeErr } = await supabase.from('scope_items').upsert(scopeInserts, { onConflict: 'job_id,trade_category_id' })
  if (scopeErr) throw new Error(`Could not persist scope_items: ${scopeErr.message}`)
  log('stage3_done', { job_id: jobId, trades: scopeInserts.length })

  // ── Stage 6: Estimate Generation (quantities only, no rates yet) ───────
  const scopeBlock = scopeInserts.map((s) => `Trade ${s.trade_category_id}: included=${JSON.stringify(s.included_scope)}, excluded=${JSON.stringify(s.excluded_scope)}, assumptions=${JSON.stringify(s.assumptions)}`).join('\n')
  const stage6System = 'You are a senior Australian residential quantity surveyor producing a full construction cost takeoff. Base every quantity on the facts and scope below — never invent a quantity or a material. When a quantity cannot be derived from anything provided, set manual_input_required = true and leave quantity/unit null rather than guessing. Use Australian units only (m2, lm, m3, each, lot, weeks, hours). Use the generate_estimate tool.'
  const stage6Content = [{ type: 'text', text: `PROJECT FACTS:\n${factsBlock}\n\nSCOPE:\n${scopeBlock}\n\nUse the generate_estimate tool.` }]
  log('stage6_calling', { job_id: jobId })
  const stage6 = await callTool(stage6System, stage6Content, ESTIMATE_GENERATION_TOOL)
  const rawItems = stage6.line_items ?? []
  if (rawItems.length === 0) throw new Error('Stage 6 returned zero line items — stop here.')

  // ── Gates (reused, not reimplemented — lib/estimating/gates.ts) ────────
  const validated = rawItems
    .filter((item) => typeof item.trade_category_id === 'number' && item.trade_category_id >= 1 && item.trade_category_id <= 13)
    .map((item) => {
      const gateResult = applyValidationGates({
        description: String(item.description ?? ''),
        quantity: item.quantity ?? null,
        unit: item.unit ?? null,
        dimensions_string: item.dimensions_string ?? null,
        pricing_type: item.pricing_type ?? 'measured',
      })
      return { ...item, ...gateResult }
    })

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
      confidence: item.confidence ?? 50, dimensions_string: item.dimensions_string ?? null,
      is_assumption: item.is_assumption ?? false, assumption_status: item.assumption_status ?? null,
      pricing_type: item.pricing_type ?? 'measured', source_ref: item.source_ref ?? null,
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

  console.log(JSON.stringify({
    event: 'estimate_complete',
    job_id: jobId,
    quote_id: quoteId,
    total_cost: finalQuote?.total_cost ?? null,
    confidence_score: finalQuote?.confidence_score ?? null,
    line_item_count: insertedItems.length,
    unresolved_assumption_count: assumptionInserts.filter((a) => a.gate !== 3).length,
  }, null, 2))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'dev_estimate_failed', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
