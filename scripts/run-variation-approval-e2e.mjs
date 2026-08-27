#!/usr/bin/env node
// ============================================================
// Production E2E for the variation-approval persistence-truthfulness fix
// (Round 5 reliability audit finding). Not part of any milestone.
//
// Creates a synthetic job + minimal quote, raises a real variation via
// POST /api/variations, approves it via the real, deployed
// POST /api/variations/[variationId]/resolve route (builder-side path —
// simpler than driving the public share-token flow, and shares the exact
// same applyApprovedVariationToQuote() call + logging this fix touches),
// then independently re-queries the DB (not the API response) to verify:
//   - variations.status = 'approved'
//   - exactly one quote_line_items row with this variation_id
//   - quotes.total_cost reflects the variation amount
//   - the resolve route's own contract_effect.applied === true
// Then calls the NEW POST /api/variations/[variationId]/retry-contract-
// application route for the same, already-applied variation and verifies
// no duplicate quote_line_items row was created (proving idempotency on a
// real, deployed instance of the new route, not just its unit tests).
//
// Cleans up all synthetic rows in a finally block.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL

const BUILDER_ID = '00000000-0000-0000-0000-0000000000f1' // reserved, distinct from every other E2E script's id

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
let variationId = null

async function cleanup() {
  try {
    if (variationId) await supabase.from('quote_line_items').delete().eq('variation_id', variationId)
    if (variationId) await supabase.from('variations').delete().eq('id', variationId)
    if (quoteId) await supabase.from('quotes').delete().eq('id', quoteId)
    if (jobId) await supabase.from('jobs').delete().eq('id', jobId)
    log('cleanup_done', { job_id: jobId, quote_id: quoteId, variation_id: variationId })
  } catch (err) {
    log('cleanup_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

async function main() {
  let passed = true
  const failures = []

  await supabase.from('builders').upsert(
    { id: BUILDER_ID, email: 'variation-approval-e2e@getworka.com', name: 'Variation Approval E2E' },
    { onConflict: 'id', ignoreDuplicates: true }
  )

  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .insert({ builder_id: BUILDER_ID, address: `${randomUUID()} Test St, Variation Approval E2E`, status: 'active' })
    .select('id')
    .single()
  if (jobErr || !job) {
    log('setup_failed', { stage: 'create_job', error: jobErr?.message })
    process.exit(1)
  }
  jobId = job.id
  log('job_created', { job_id: jobId })

  const { data: quote, error: quoteErr } = await supabase
    .from('quotes')
    .insert({ job_id: jobId, builder_id: BUILDER_ID, status: 'approved', total_cost: 10000, margin_pct: 0.2, confidence_score: 100, version: 1 })
    .select('id')
    .single()
  if (quoteErr || !quote) {
    log('setup_failed', { stage: 'create_quote', error: quoteErr?.message })
    await cleanup()
    process.exit(1)
  }
  quoteId = quote.id
  log('quote_created', { quote_id: quoteId, job_id: jobId })

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'x-worka-builder-id': BUILDER_ID,
  }

  // ── Raise a real variation via the real route ─────────────────────────
  const variationAmount = 1500
  const createRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/variations`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      job_id: jobId,
      title: 'E2E extra plumbing point',
      description: 'Synthetic variation for the approval-persistence-truthfulness E2E',
      amount: variationAmount,
      trade_category_id: 6, // Plumbing, per lib/trade-taxonomy.ts's fixed 1-13 numbering
    }),
  })
  const createBody = await createRes.json().catch(() => ({}))
  if (!createRes.ok || !createBody.variation?.id) {
    log('setup_failed', { stage: 'create_variation', http_status: createRes.status, body: createBody })
    await cleanup()
    process.exit(1)
  }
  variationId = createBody.variation.id
  log('variation_created', { variation_id: variationId, amount: variationAmount })

  // ── Approve it via the real, deployed resolve route ───────────────────
  const resolveRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/variations/${variationId}/resolve`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ builder_id: BUILDER_ID, action: 'approved' }),
  })
  const resolveBody = await resolveRes.json().catch(() => ({}))
  log('resolve_call', { http_status: resolveRes.status, body: resolveBody })

  if (!resolveRes.ok) {
    passed = false
    failures.push(`resolve call returned non-2xx: ${resolveRes.status}`)
  }
  if (resolveBody.contract_effect?.applied !== true) {
    passed = false
    failures.push(`expected contract_effect.applied === true, got ${JSON.stringify(resolveBody.contract_effect)}`)
  }

  // ── Independent DB verification — not trusting the API response alone ──
  const { data: variationRow } = await supabase
    .from('variations')
    .select('status')
    .eq('id', variationId)
    .single()
  log('variation_state_after_approval', variationRow ?? {})
  if (variationRow?.status !== 'approved') {
    passed = false
    failures.push(`expected variations.status='approved', got '${variationRow?.status}'`)
  }

  const { data: lineItemsAfterApproval } = await supabase
    .from('quote_line_items')
    .select('id, variation_id, total, trade_category_id')
    .eq('variation_id', variationId)
  log('line_items_after_approval', { count: lineItemsAfterApproval?.length ?? 0, rows: lineItemsAfterApproval })
  if ((lineItemsAfterApproval?.length ?? 0) !== 1) {
    passed = false
    failures.push(`expected exactly 1 quote_line_items row for this variation, found ${lineItemsAfterApproval?.length ?? 0}`)
  } else if (lineItemsAfterApproval[0].total !== variationAmount) {
    passed = false
    failures.push(`expected line item total ${variationAmount}, got ${lineItemsAfterApproval[0].total}`)
  }

  const { data: quoteAfterApproval } = await supabase
    .from('quotes')
    .select('total_cost')
    .eq('id', quoteId)
    .single()
  log('quote_state_after_approval', quoteAfterApproval ?? {})
  // recomputeQuoteTotals sums quote_line_items.total across the quote —
  // this quote started with none, so after the variation it should equal
  // exactly the variation amount.
  if (quoteAfterApproval?.total_cost !== variationAmount) {
    passed = false
    failures.push(`expected quotes.total_cost to reflect the variation (${variationAmount}), got ${quoteAfterApproval?.total_cost}`)
  }

  // ── Retry the (already-applied) contract application via the new route ─
  const retryRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/variations/${variationId}/retry-contract-application`, {
    method: 'POST',
    headers: authHeaders,
  })
  const retryBody = await retryRes.json().catch(() => ({}))
  log('retry_call', { http_status: retryRes.status, body: retryBody })

  if (!retryRes.ok) {
    passed = false
    failures.push(`retry call returned non-2xx: ${retryRes.status}`)
  }
  if (retryBody.contract_effect?.applied !== true) {
    passed = false
    failures.push(`expected retry contract_effect.applied === true (already applied), got ${JSON.stringify(retryBody.contract_effect)}`)
  }

  const { data: lineItemsAfterRetry } = await supabase
    .from('quote_line_items')
    .select('id')
    .eq('variation_id', variationId)
  log('line_items_after_retry', { count: lineItemsAfterRetry?.length ?? 0 })
  if ((lineItemsAfterRetry?.length ?? 0) !== 1) {
    passed = false
    failures.push(`retry created a duplicate line item — expected exactly 1, found ${lineItemsAfterRetry?.length ?? 0}`)
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
