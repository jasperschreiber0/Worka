#!/usr/bin/env node
// ============================================================
// WorkA — one real residential project through the real production pipeline
// ============================================================
// Drives a genuine (not deliberately-sparse) residential renovation scope
// through the SAME code path production uses: upload -> files row ->
// document_processing_batches/jobs -> document-worker (real edge function,
// real extraction) -> smooth-responder (real edge function, Stage 1/2 -> 3
// -> 6, chunked/wall-clock-budgeted exactly like production) -> pricing
// (ensureQuotePriced, triggered here explicitly since nothing calls the
// authenticated Next.js intake/quote routes in this script) -> the SAME
// pg_cron-driven reconcile_estimate_run/enforce_estimate_deadlines that
// sets estimate_runs.builder_status on a live schedule, no direct write
// from this script.
//
// Deliberately does NOT delete the job afterward (unlike
// synthetic-intake-health-check.mjs) — this run's whole point is to leave
// a real, inspectable ESTIMATE_READY quote behind.
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
//     node scripts/dev-run-real-project-e2e.mjs

import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'
import { ensureQuotePriced } from '../lib/pricing.ts'
import { runQualityAssurance } from '../lib/estimating/qa.ts'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and NEXT_PUBLIC_SUPABASE_ANON_KEY must all be set' }))
  process.exit(1)
}

const BUILDER_ID = '00000000-0000-0000-0000-0000000000fe' // same reserved test builder as synthetic-intake-health-check.mjs

const EXTRACTION_TIMEOUT_MS = 90_000
const CLASSIFICATION_TIMEOUT_MS = 360_000 // covers a full Stage1/2->3->6 invocation, real project, real Claude calls
const RECONCILE_TIMEOUT_MS = 180_000 // pg_cron ticks every 60s; allow a couple of ticks
const POLL_INTERVAL_MS = 5_000

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pdfEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

// A genuine (not deliberately sparse) scope-of-works brief for a real
// residential kitchen + bathroom renovation — enough concrete, evidence-
// backed detail for Stage 3 to reason about multiple real trades and Stage
// 6 to produce a genuine multi-item takeoff, without needing scanned plans.
const SCOPE_LINES = [
  'WorkA Estimate Validation Project',
  '24 Banksia Grove, Frankston VIC 3199',
  '',
  'Project: Kitchen and bathroom renovation, single storey brick veneer dwelling.',
  'Site: Established suburban block. Existing driveway and services connected.',
  'No structural work required. No load-bearing walls affected. No scaffolding required.',
  'Builder estimate: single storey, 6 week construction program. Finish level: mid-range, contemporary style.',
  '',
  'Scope of works:',
  '',
  '1. Demolition',
  'Remove existing kitchen cabinetry, benchtop and splashback tiles.',
  'Remove existing bathroom fixtures including bath, vanity, and wall and floor tiles.',
  'Approximately 12m2 kitchen floor area and 6m2 bathroom floor area affected.',
  '',
  '2. Kitchen joinery and fitout',
  'Supply and install new laminate kitchen cabinetry, base and overhead units, 8 lineal metre run.',
  'Supply and install 40mm reconstituted stone benchtop to kitchen, 8 lineal metres.',
  'Supply and install ceramic splashback tiling, 4m2.',
  'Supply and install new stainless steel sink and mixer tap.',
  'Allow space and services for a freestanding 900mm oven and cooktop (appliances supplied by owner).',
  '',
  '3. Bathroom renovation',
  'Full waterproofing membrane to floor and walls, 6m2 bathroom.',
  'Supply and install new floor and wall tiles to 2000mm height in wet areas, 6m2 floor plus 22m2 walls.',
  'Supply and install new semi-frameless shower screen.',
  'Supply and install new wall-hung vanity with stone top.',
  'Supply and install new toilet suite.',
  'Supply and install new heated towel rail.',
  '',
  '4. Electrical',
  'New dedicated circuit for kitchen appliances.',
  'Supply and install 8 LED downlights across kitchen and bathroom.',
  'Supply and install 4 new double GPOs in kitchen.',
  'Supply and install 2 new weatherproof GPOs on rear patio.',
  'Supply and install new exhaust fan in bathroom, ducted to external wall.',
  '',
  '5. Plumbing',
  'Relocate kitchen sink plumbing, 1.5 lineal metres.',
  'New hot and cold water points for bathroom vanity and shower.',
  'New drainage connections for relocated and new fixtures.',
  'Supply and install new instantaneous gas hot water unit, external wall mounted.',
  '',
  '6. Painting',
  'Two coat repaint, walls and ceilings, kitchen and bathroom.',
  'Approximately 40m2 wall area and 18m2 ceiling area, low sheen acrylic finish.',
  '',
  '7. Flooring',
  'Supply and install new waterproof vinyl plank flooring to kitchen, 12m2.',
  'Supply matching transition strip to existing hallway flooring.',
  '',
  'End of scope of works.',
]

function buildScopePdf() {
  const fontSize = 10
  const lineHeight = 13
  const startY = 760
  const lines = SCOPE_LINES.map((l, i) => {
    const y = i === 0 ? startY : -lineHeight
    const op = i === 0 ? 'Td' : 'Td'
    const text = pdfEscape(l.length === 0 ? ' ' : l)
    return i === 0
      ? `BT /F1 ${fontSize} Tf 54 ${startY} Td (${text}) Tj`
      : `0 -${lineHeight} Td (${text}) Tj`
  })
  const streamText = lines.join('\n') + '\nET'

  const objects = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] = '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>'
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  objects[5] = `<< /Length ${Buffer.byteLength(streamText, 'utf8')} >>\nstream\n${streamText}\nendstream`

  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(body, 'utf8')
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(body, 'utf8')
  let xref = 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return Buffer.from(body + xref + trailer, 'utf8')
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const jobId = crypto.randomUUID()
  const storagePath = `real-project-validation/${jobId}/scope-of-works.pdf`

  log('run_started', { job_id: jobId })

  await supabase.from('builders').upsert(
    { id: BUILDER_ID, email: 'health-check@getworka.com', name: 'Synthetic Health Check' },
    { onConflict: 'id', ignoreDuplicates: true }
  )

  const { error: jobErr } = await supabase.from('jobs').insert({
    id: jobId,
    builder_id: BUILDER_ID,
    address: '24 Banksia Grove, Frankston VIC 3199 (WorkA real-project validation run)',
    status: 'quoting',
  })
  if (jobErr) throw new Error(`job insert failed: ${jobErr.message}`)
  log('job_created', { job_id: jobId })

  const pdfBuffer = buildScopePdf()
  const { error: uploadErr } = await supabase.storage
    .from('plans')
    .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true })
  if (uploadErr) throw new Error(`storage upload failed: ${uploadErr.message}`)

  const { data: fileRow, error: fileErr } = await supabase
    .from('files')
    .insert({
      job_id: jobId, builder_id: BUILDER_ID, storage_path: storagePath,
      filename: 'scope-of-works.pdf', file_type: 'pdf', intake_status: 'uploaded',
    })
    .select()
    .single()
  if (fileErr || !fileRow) throw new Error(`files insert failed: ${fileErr?.message ?? 'no row returned'}`)
  log('uploaded', { job_id: jobId, file_id: fileRow.id, bytes: pdfBuffer.length })

  const { data: batchRow, error: batchErr } = await supabase
    .from('document_processing_batches')
    .insert({ job_id: jobId, builder_id: BUILDER_ID, primary_file_id: fileRow.id, status: 'running' })
    .select()
    .single()
  if (batchErr || !batchRow) throw new Error(`batch insert failed: ${batchErr?.message ?? 'no row returned'}`)

  const { error: jobsInsertErr } = await supabase
    .from('document_processing_jobs')
    .insert({ parent_job_id: batchRow.id, document_id: fileRow.id })
  if (jobsInsertErr) throw new Error(`document_processing_jobs insert failed: ${jobsInsertErr.message}`)

  await supabase.from('files').update({ processing_batch_id: batchRow.id, intake_status: 'processing' }).eq('id', fileRow.id)
  log('batch_created', { job_id: jobId, batch_id: batchRow.id })

  const workerRes = await fetch(`${SUPABASE_URL}/functions/v1/document-worker`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}` },
    body: JSON.stringify({ parent_job_id: batchRow.id, builder_id: BUILDER_ID }),
  })
  if (!workerRes.ok) throw new Error(`document-worker invocation failed: HTTP ${workerRes.status} ${await workerRes.text().catch(() => '')}`)
  log('worker_invoked', { job_id: jobId, batch_id: batchRow.id, status: workerRes.status })

  // ── Poll extraction terminal ────────────────────────────────────────
  let extractionTerminal = null
  {
    const deadline = Date.now() + EXTRACTION_TIMEOUT_MS
    while (Date.now() < deadline) {
      const { data: jobs } = await supabase
        .from('document_processing_jobs')
        .select('status, error_message, attempts')
        .eq('parent_job_id', batchRow.id)
      const row = jobs?.[0]
      if (row && (row.status === 'completed' || row.status === 'failed')) { extractionTerminal = row; break }
      await sleep(POLL_INTERVAL_MS)
    }
  }
  if (!extractionTerminal) throw new Error(`extraction did not reach a terminal state within ${EXTRACTION_TIMEOUT_MS}ms`)
  log('extraction_terminal', { job_id: jobId, status: extractionTerminal.status })
  if (extractionTerminal.status === 'failed') throw new Error(`document extraction failed: ${extractionTerminal.error_message}`)

  // ── Poll batch terminal + classification_triggered ──────────────────
  let batchTerminal = null
  {
    const deadline = Date.now() + EXTRACTION_TIMEOUT_MS
    while (Date.now() < deadline) {
      const { data: b } = await supabase
        .from('document_processing_batches')
        .select('status, classification_triggered')
        .eq('id', batchRow.id)
        .single()
      if (b && b.status !== 'pending' && b.status !== 'running') { batchTerminal = b; break }
      await sleep(POLL_INTERVAL_MS)
    }
  }
  if (!batchTerminal) throw new Error('document_processing_batches never left running/pending')
  if (!batchTerminal.classification_triggered) throw new Error('batch reached terminal status but classification_triggered was never flipped true')
  log('batch_terminal', { job_id: jobId, status: batchTerminal.status })

  // ── Poll for the full Stage1/2->3->6 run: quote_id appearing on the
  //    batch is the real production signal that Stage 6 completed. ─────
  let quoteId = null
  let stallInfo = null
  {
    const deadline = Date.now() + CLASSIFICATION_TIMEOUT_MS
    while (Date.now() < deadline) {
      const { data: b } = await supabase
        .from('document_processing_batches')
        .select('quote_id, stall_stage, stall_reason, stall_count')
        .eq('id', batchRow.id)
        .single()
      if (b?.quote_id) { quoteId = b.quote_id; break }
      if (b?.stall_reason) stallInfo = b
      const { data: f } = await supabase.from('files').select('intake_status, failure_stage, failure_reason').eq('id', fileRow.id).single()
      if (f?.intake_status === 'failed') throw new Error(`file failed: ${f.failure_stage} — ${f.failure_reason}`)
      await sleep(POLL_INTERVAL_MS)
    }
  }
  if (!quoteId) {
    throw new Error(`Stage 6 never completed (no quote_id on batch) within ${CLASSIFICATION_TIMEOUT_MS}ms.` + (stallInfo ? ` Last stall: ${stallInfo.stall_stage} — ${stallInfo.stall_reason} (stall_count=${stallInfo.stall_count})` : ' No stall recorded — may still be genuinely in progress or need a recovery-cron-triggered resume.'))
  }
  log('quote_created', { job_id: jobId, quote_id: quoteId })

  // ── Quote line items — real Stage 6 output ──────────────────────────
  const { data: lineItems } = await supabase.from('quote_line_items').select('id, trade_category_id, description, quantity, unit, rate, total, pricing_source, pricing_type').eq('quote_id', quoteId)
  log('line_items_generated', { job_id: jobId, quote_id: quoteId, count: lineItems?.length ?? 0 })
  if (!lineItems || lineItems.length === 0) throw new Error('Stage 6 produced zero line items')

  console.log(JSON.stringify({ event: 'stage_summary', job_id: jobId, quote_id: quoteId, line_item_count: lineItems.length, sample: lineItems.slice(0, 5) }, null, 2))

  // ── Pricing — real production code (lib/pricing.ts), same function the
  //    Next.js intake/quote routes call. Nothing in this script's flow so
  //    far hit an authenticated Next.js route (this is the Edge Function
  //    half of the pipeline only), so pricing needs an explicit call here —
  //    exactly the same gap dev-generate-estimate.mjs's header comment
  //    documents, not a new one. ────────────────────────────────────────
  const priced = await ensureQuotePriced(supabase, quoteId)
  log('pricing_done', { job_id: jobId, quote_id: quoteId, priced })

  const qaReport = await runQualityAssurance(supabase, quoteId, jobId)
  log('qa_done', { job_id: jobId, quote_id: quoteId, top_risks: qaReport?.top_risks?.length ?? 0 })

  const { data: finalQuote } = await supabase
    .from('quotes')
    .select('id, total_cost, confidence_score, margin_pct, price_coverage_pct, pricing_match_rate_pct')
    .eq('id', quoteId)
    .single()
  const { data: finalItems } = await supabase.from('quote_line_items').select('total, assumption_status').eq('quote_id', quoteId)
  const included = (finalItems ?? []).filter((i) => i.assumption_status !== 'excluded')
  const pricedCount = included.filter((i) => i.total !== null).length

  log('pricing_summary', {
    job_id: jobId, quote_id: quoteId,
    total_cost: finalQuote?.total_cost ?? null,
    price_coverage_pct: finalQuote?.price_coverage_pct ?? null,
    priced_line_items: pricedCount, total_line_items: included.length,
  })

  // ── builder_status — deliberately NOT set by this script. The real
  //    mechanism (reconcile_estimate_run, called from pg_cron's
  //    intake-recovery sweep every minute) is what must set it, so this
  //    poll is the actual end-to-end proof, not a workaround. ───────────
  let builderStatus = null
  {
    const deadline = Date.now() + RECONCILE_TIMEOUT_MS
    while (Date.now() < deadline) {
      const { data: run } = await supabase
        .from('estimate_runs')
        .select('builder_status, needs_review_reason, completed_at')
        .eq('batch_id', batchRow.id)
        .maybeSingle()
      if (run?.builder_status) { builderStatus = run; break }
      await sleep(POLL_INTERVAL_MS)
    }
  }

  console.log(JSON.stringify({
    event: 'run_complete',
    job_id: jobId, quote_id: quoteId, batch_id: batchRow.id,
    builder_status: builderStatus?.builder_status ?? null,
    needs_review_reason: builderStatus?.needs_review_reason ?? null,
    total_cost: finalQuote?.total_cost ?? null,
    price_coverage_pct: finalQuote?.price_coverage_pct ?? null,
    priced_line_items: pricedCount, total_line_items: included.length,
    passed: builderStatus?.builder_status === 'ESTIMATE_READY' || builderStatus?.builder_status === 'ESTIMATE_READY_WITH_WARNINGS',
  }, null, 2))

  if (!builderStatus) {
    throw new Error(`estimate_runs.builder_status was never set within ${RECONCILE_TIMEOUT_MS}ms — pg_cron's reconcile sweep should have picked this batch up automatically`)
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'run_failed', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
