#!/usr/bin/env node
// ============================================================
// Production E2E for reliability audit Round 4 finding #1
// (POST /api/assumptions/[quoteId]/resolve persistence truthfulness).
//
// Creates a synthetic job + a draft quote + one quote_line_item + one
// unresolved assumption linked to it, then calls the REAL, deployed
// POST /api/assumptions/[quoteId]/resolve route twice: first a genuine
// "adjusted" resolution, then an identical resubmission (retry/idempotency
// check). After each call, independently re-queries assumptions,
// quote_line_items, quotes, and estimator_corrections directly via the
// Supabase client -- does not trust the API response body.
//
// Verifies:
//   1. assumptions.resolution_type / resolved_at / resolved_by set correctly
//   2. the linked quote_line_items row reflects the adjustment
//      (quantity/unit/total, assumption_status)
//   3. quotes.total_cost reflects the adjusted line item
//   4. quotes.status advances to pending_review once all assumptions on
//      the quote are resolved (this quote has exactly one)
//   5. quotes.qa_report is populated (QA ran)
//   6. resubmitting the identical resolution does not create a duplicate
//      estimator_corrections row, does not change total_cost, and does not
//      create a second quote/line item
//
// Cleans up its own synthetic rows in a finally block.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.APP_URL

const BUILDER_ID = '00000000-0000-0000-0000-0000000000f0' // reserved, distinct from every other E2E script's id

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL must be set' }))
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

let jobId = null
let quoteId = null
let lineItemId = null
let assumptionId = null

async function cleanup() {
  try {
    if (quoteId) {
      await supabase.from('estimator_corrections').delete().eq('quote_id', quoteId)
      await supabase.from('assumptions').delete().eq('quote_id', quoteId)
      await supabase.from('quote_line_items').delete().eq('quote_id', quoteId)
      await supabase.from('quotes').delete().eq('id', quoteId)
    }
    if (jobId) {
      await supabase.from('jobs').delete().eq('id', jobId)
    }
    log('cleanup_done', { job_id: jobId, quote_id: quoteId })
  } catch (err) {
    log('cleanup_failed', { job_id: jobId, error: err instanceof Error ? err.message : String(err) })
  }
}

async function main() {
  let passed = true
  const failures = []

  // ── Setup ──────────────────────────────────────────────────────────────
  await supabase.from('builders').upsert(
    { id: BUILDER_ID, email: 'assumption-resolution-e2e@getworka.com', name: 'Assumption Resolution E2E' },
    { onConflict: 'id', ignoreDuplicates: true }
  )

  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .insert({ builder_id: BUILDER_ID, address: `${randomUUID()} Test St, Assumption Resolution E2E`, status: 'quoting' })
    .select('id')
    .single()
  if (jobErr || !job) {
    log('setup_failed', { stage: 'create_job', error: jobErr?.message })
    process.exit(1)
  }
  jobId = job.id

  const { data: quote, error: quoteErr } = await supabase
    .from('quotes')
    .insert({ job_id: jobId, builder_id: BUILDER_ID, status: 'draft', total_cost: null, margin_pct: 0.2, version: 1 })
    .select('id')
    .single()
  if (quoteErr || !quote) {
    log('setup_failed', { stage: 'create_quote', error: quoteErr?.message })
    await cleanup()
    process.exit(1)
  }
  quoteId = quote.id

  // trade_category_id 1 is a real, immutable seeded trade (locked sort_order 1-13)
  const { data: lineItem, error: liErr } = await supabase
    .from('quote_line_items')
    .insert({
      quote_id: quoteId, trade_category_id: 1, description: 'E2E test item — demolition allowance',
      quantity: null, unit: null, rate: 50, total: null, confidence: 40,
      is_assumption: true, assumption_status: 'unresolved',
    })
    .select('id')
    .single()
  if (liErr || !lineItem) {
    log('setup_failed', { stage: 'create_line_item', error: liErr?.message })
    await cleanup()
    process.exit(1)
  }
  lineItemId = lineItem.id

  const { data: assumption, error: assumptionErr } = await supabase
    .from('assumptions')
    .insert({
      quote_id: quoteId, line_item_id: lineItemId,
      description: 'Quantity not specified in source documents — Gate 1 (Manual Input Required)',
      resolution_type: null,
    })
    .select('id')
    .single()
  if (assumptionErr || !assumption) {
    log('setup_failed', { stage: 'create_assumption', error: assumptionErr?.message })
    await cleanup()
    process.exit(1)
  }
  assumptionId = assumption.id

  log('setup_complete', { job_id: jobId, quote_id: quoteId, line_item_id: lineItemId, assumption_id: assumptionId })

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'x-worka-builder-id': BUILDER_ID,
  }
  const adjustedQuantity = 25
  const adjustedUnit = 'm2'
  const resolveBody = {
    assumption_id: assumptionId, resolution: 'adjusted',
    adjusted_quantity: adjustedQuantity, adjusted_unit: adjustedUnit,
  }

  // ── Call 1: real resolution ───────────────────────────────────────────
  const res1 = await fetch(`${APP_URL.replace(/\/$/, '')}/api/assumptions/${quoteId}/resolve`, {
    method: 'POST', headers: authHeaders, body: JSON.stringify(resolveBody),
  })
  const body1 = await res1.json().catch(() => ({}))
  log('resolve_call_1', { http_status: res1.status, body: body1 })

  if (res1.status !== 200) {
    passed = false
    failures.push(`call 1: expected HTTP 200, got ${res1.status}`)
  }

  // Independent DB verification -- not trusting the API response.
  const { data: assumptionRow1 } = await supabase
    .from('assumptions').select('resolution_type, resolved_at, resolved_by').eq('id', assumptionId).single()
  log('assumptions_state_after_call_1', assumptionRow1 ?? {})
  if (assumptionRow1?.resolution_type !== 'adjusted' || !assumptionRow1?.resolved_at || !assumptionRow1?.resolved_by) {
    passed = false
    failures.push('call 1: assumptions row not correctly marked resolved')
  }

  const { data: lineItemRow1 } = await supabase
    .from('quote_line_items').select('assumption_status, quantity, unit, total, rate').eq('id', lineItemId).single()
  log('line_item_state_after_call_1', lineItemRow1 ?? {})
  if (
    lineItemRow1?.assumption_status !== 'adjusted' ||
    Number(lineItemRow1?.quantity) !== adjustedQuantity ||
    lineItemRow1?.unit !== adjustedUnit ||
    Number(lineItemRow1?.total) !== adjustedQuantity * 50
  ) {
    passed = false
    failures.push(`call 1: quote_line_items row does not reflect the resolution (got ${JSON.stringify(lineItemRow1)})`)
  }

  const { data: quoteRow1 } = await supabase
    .from('quotes').select('status, total_cost, qa_report').eq('id', quoteId).single()
  log('quote_state_after_call_1', { status: quoteRow1?.status, total_cost: quoteRow1?.total_cost, has_qa_report: quoteRow1?.qa_report !== null })
  if (quoteRow1?.status !== 'pending_review') {
    passed = false
    failures.push(`call 1: expected quote status pending_review (only assumption on this quote is now resolved), got ${quoteRow1?.status}`)
  }
  if (Number(quoteRow1?.total_cost) !== adjustedQuantity * 50) {
    passed = false
    failures.push(`call 1: expected total_cost ${adjustedQuantity * 50}, got ${quoteRow1?.total_cost}`)
  }
  if (quoteRow1?.qa_report === null || quoteRow1?.qa_report === undefined) {
    passed = false
    failures.push('call 1: qa_report was not populated — QA did not run')
  }

  const { data: corrections1 } = await supabase
    .from('estimator_corrections').select('id, field, ai_predicted, human_corrected').eq('quote_id', quoteId)
  log('estimator_corrections_after_call_1', { count: corrections1?.length ?? 0, rows: corrections1 })
  if ((corrections1?.length ?? 0) === 0) {
    passed = false
    failures.push('call 1: expected at least one estimator_corrections row for a genuine quantity/unit correction')
  }

  // ── Call 2: identical resubmission — retry/idempotency check ─────────
  const res2 = await fetch(`${APP_URL.replace(/\/$/, '')}/api/assumptions/${quoteId}/resolve`, {
    method: 'POST', headers: authHeaders, body: JSON.stringify(resolveBody),
  })
  const body2 = await res2.json().catch(() => ({}))
  log('resolve_call_2_resubmission', { http_status: res2.status, body: body2 })

  const { data: quoteRow2 } = await supabase
    .from('quotes').select('status, total_cost').eq('id', quoteId).single()
  log('quote_state_after_call_2', quoteRow2 ?? {})
  if (Number(quoteRow2?.total_cost) !== adjustedQuantity * 50) {
    passed = false
    failures.push(`call 2: total_cost drifted on resubmission — expected ${adjustedQuantity * 50}, got ${quoteRow2?.total_cost}`)
  }
  if (quoteRow2?.status !== 'pending_review') {
    passed = false
    failures.push(`call 2: quote status changed unexpectedly on resubmission — got ${quoteRow2?.status}`)
  }

  const { data: corrections2 } = await supabase
    .from('estimator_corrections').select('id').eq('quote_id', quoteId)
  log('estimator_corrections_after_call_2', { count: corrections2?.length ?? 0 })
  if ((corrections2?.length ?? 0) !== (corrections1?.length ?? 0)) {
    passed = false
    failures.push(`call 2: estimator_corrections count changed on resubmission — expected ${corrections1?.length ?? 0}, got ${corrections2?.length ?? 0} (duplicate insert)`)
  }

  const { count: quoteCount } = await supabase.from('quotes').select('id', { count: 'exact', head: true }).eq('job_id', jobId)
  const { count: lineItemCount } = await supabase.from('quote_line_items').select('id', { count: 'exact', head: true }).eq('quote_id', quoteId)
  log('duplicate_check', { quotes_for_job: quoteCount, line_items_for_quote: lineItemCount })
  if (quoteCount !== 1) {
    passed = false
    failures.push(`expected exactly 1 quote for this job, found ${quoteCount}`)
  }
  if (lineItemCount !== 1) {
    passed = false
    failures.push(`expected exactly 1 line item for this quote, found ${lineItemCount}`)
  }

  log(passed ? 'run_passed' : 'run_FAILED', { passed, failures })
  await cleanup()
  process.exit(passed ? 0 : 1)
}

main().catch(async (err) => {
  log('run_crashed', { error: err instanceof Error ? err.stack : String(err) })
  await cleanup()
  process.exit(1)
})
