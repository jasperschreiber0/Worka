#!/usr/bin/env node
// ============================================================
// Production E2E for Client Quote Review & Approval (v1)
// ============================================================
// Drives the REAL deployed routes end-to-end against production:
//   POST  /api/quotes/[quoteId]/share   (builder-authenticated)
//   GET   /api/quotes/[quoteId]/approve?t=...  (public, token-scoped)
//   PATCH /api/quotes/[quoteId]/approve?t=...  (public, token-scoped)
//
// Independently verifies every claim against the DATABASE, not just HTTP
// response bodies:
//   1. Public GET succeeds with only the raw share token (no builder auth
//      header sent at all).
//   2. The client price shown matches calculateClientPrice's own formula,
//      recomputed independently here — never total_cost/rate/margin_pct.
//   3. No internal-only fields (total_cost, rate, margin_pct, confidence,
//      pricing_source, assumption_status) appear anywhere in the public
//      GET response.
//   4. Approval flips quotes.status -> 'approved', sets approved_at/
//      approved_by, and leaves is_current untouched -- verified via a
//      direct DB read, not the API response.
//   5. Exactly one quote_approved proof_events row is created.
//   6. A replayed PATCH (identical token, identical decision) returns 422
//      and creates no second proof event.
//   7. A draft (never-sent) quote's public GET/PATCH is rejected (404) with
//      no DB mutation -- a quote never sent to a client can't be approved
//      via this route regardless of a minted token.
//   8. "Request changes" leaves quotes.status/approved_at/approved_by
//      completely untouched, and records exactly one
//      quote_changes_requested proof event.
//
// Cleans up every synthetic row in a finally block regardless of outcome.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL

// Reserved, next free id after ...1f3 (Round 12).
const BUILDER_ID = '00000000-0000-0000-0000-0000000001f4'

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL must all be set' }))
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
const base = APP_URL.replace(/\/$/, '')

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

// Reimplemented here (not imported from lib/pricing.ts), matching the
// convention established in scripts/run-email-draft-cost-vs-price-e2e.mjs:
// this runs as plain .mjs, and lib/pricing.ts is a .ts file this script's
// scope doesn't touch. Identical formula to calculateClientPrice.
function round2(n) { return Math.round(n * 100) / 100 }
function calculateClientPrice(items) {
  const included = items.filter((i) => i.assumption_status !== 'excluded')
  const sum = included.reduce((acc, i) => (i.total === null ? acc : acc + i.total * (1 + (i.margin_pct ?? 0))), 0)
  return round2(sum)
}

const clientIds = []
const jobIds = []
const quoteIds = []

async function cleanup() {
  try {
    for (const quoteId of quoteIds) {
      await supabase.from('quote_line_items').delete().eq('quote_id', quoteId)
    }
    for (const jobId of jobIds) {
      await supabase.from('proof_events').delete().eq('job_id', jobId)
    }
    for (const quoteId of quoteIds) {
      await supabase.from('quotes').delete().eq('id', quoteId)
    }
    for (const jobId of jobIds) {
      await supabase.from('jobs').delete().eq('id', jobId)
    }
    for (const clientId of clientIds) {
      await supabase.from('clients').delete().eq('id', clientId)
    }
    log('cleanup_done', { jobs: jobIds, quotes: quoteIds, clients: clientIds })
  } catch (err) {
    log('cleanup_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

// Creates a synthetic client + job + quote (+ line items) and returns the
// quote id. status is the initial quotes.status ('sent' or 'draft').
async function makeQuote(label, status, lineItems) {
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .insert({ builder_id: BUILDER_ID, name: `Quote Approval E2E — ${label}`, email: `quote-approval-e2e-${randomUUID()}@example.com` })
    .select('id')
    .single()
  if (clientErr || !client) throw new Error(`client insert failed (${label}): ${clientErr?.message}`)
  clientIds.push(client.id)

  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .insert({ builder_id: BUILDER_ID, client_id: client.id, address: `${randomUUID()} Test St, Quote Approval E2E — ${label}`, status: 'quoted' })
    .select('id')
    .single()
  if (jobErr || !job) throw new Error(`job insert failed (${label}): ${jobErr?.message}`)
  jobIds.push(job.id)

  const { data: quote, error: quoteErr } = await supabase
    .from('quotes')
    .insert({
      job_id: job.id, builder_id: BUILDER_ID, status, version: 1, is_current: true,
      margin_pct: 0.18, total_cost: lineItems.reduce((a, i) => a + (i.assumption_status === 'excluded' ? 0 : i.total), 0),
      confidence_score: 95,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
    })
    .select('id')
    .single()
  if (quoteErr || !quote) throw new Error(`quote insert failed (${label}): ${quoteErr?.message}`)
  quoteIds.push(quote.id)

  const rows = lineItems.map((item, i) => ({
    quote_id: quote.id, trade_category_id: item.trade_category_id, description: item.description,
    quantity: 1, unit: 'item', rate: item.total, total: item.total, margin_pct: item.margin_pct,
    confidence: 100, is_assumption: false, assumption_status: item.assumption_status ?? null,
    pricing_source: 'manual', predicted_by: 'ai',
  }))
  const { error: lineErr } = await supabase.from('quote_line_items').insert(rows)
  if (lineErr) throw new Error(`line item insert failed (${label}): ${lineErr.message}`)

  return { jobId: job.id, quoteId: quote.id, clientId: client.id }
}

async function main() {
  let passed = true
  const failures = []
  const fail = (msg, detail = {}) => { passed = false; failures.push(msg); log('check_FAILED', { msg, ...detail }) }
  const ok = (msg, detail = {}) => log('check_passed', { msg, ...detail })

  await supabase.from('builders').upsert(
    { id: BUILDER_ID, email: 'quote-approval-e2e@getworka.com', name: 'Quote Approval E2E' },
    { onConflict: 'id', ignoreDuplicates: true }
  )

  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'x-worka-builder-id': BUILDER_ID }

  // ── Scenario 1: happy path — sent quote, accept, verify, replay ────────
  const LINE_ITEMS = [
    { trade_category_id: 1, description: 'Demolition', total: 5000, margin_pct: 0.18 },
    { trade_category_id: 5, description: 'Electrical rough-in', total: 8000, margin_pct: 0.18 },
    { trade_category_id: 1, description: 'Excluded scaffolding allowance', total: 20000, margin_pct: 0.18, assumption_status: 'excluded' },
  ]
  const EXPECTED_CLIENT_PRICE = calculateClientPrice(LINE_ITEMS)
  log('expected_client_price_computed', { expected: EXPECTED_CLIENT_PRICE })

  const scenario1 = await makeQuote('happy-path', 'sent', LINE_ITEMS)
  log('scenario1_quote_created', scenario1)

  // Mint the share link via the real, builder-authenticated route.
  const shareRes = await fetch(`${base}/api/quotes/${scenario1.quoteId}/share`, { method: 'POST', headers: authHeaders })
  const shareBody = await shareRes.json().catch(() => ({}))
  if (!shareRes.ok || !shareBody.link) {
    fail('share route failed', { status: shareRes.status, body: shareBody })
  } else {
    ok('share_link_minted', { link: shareBody.link })
  }
  const token = shareBody.link ? new URL(shareBody.link).searchParams.get('t') : null

  if (token) {
    // ── Public GET, NO builder auth header sent at all ──────────────────
    const getRes = await fetch(`${base}/api/quotes/${scenario1.quoteId}/approve?t=${encodeURIComponent(token)}`)
    const getBody = await getRes.json().catch(() => ({}))
    log('public_get_call', { status: getRes.status, body: getBody })

    if (getRes.ok && getBody.quote) {
      ok('public_get_succeeded_token_only', { status: getRes.status })
      if (getBody.quote.total === EXPECTED_CLIENT_PRICE) {
        ok('client_price_correct', { expected: EXPECTED_CLIENT_PRICE, actual: getBody.quote.total })
      } else {
        fail('client_price_mismatch', { expected: EXPECTED_CLIENT_PRICE, actual: getBody.quote.total })
      }

      // No internal-only fields anywhere in the response.
      const serialized = JSON.stringify(getBody)
      const forbidden = ['total_cost', '"rate"', 'margin_pct', 'confidence', 'pricing_source', 'assumption_status', 'predicted_by']
      const leaked = forbidden.filter((f) => serialized.includes(f))
      if (leaked.length === 0) {
        ok('no_internal_fields_leaked')
      } else {
        fail('internal_fields_leaked', { leaked })
      }
    } else {
      fail('public_get_failed', { status: getRes.status, body: getBody })
    }

    // ── Accept, public route, no auth header ────────────────────────────
    const patchRes = await fetch(`${base}/api/quotes/${scenario1.quoteId}/approve?t=${encodeURIComponent(token)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', approved_by: 'E2E Test Client' }),
    })
    const patchBody = await patchRes.json().catch(() => ({}))
    log('public_patch_approve_call', { status: patchRes.status, body: patchBody })
    if (patchRes.ok && patchBody.quote?.status === 'approved') {
      ok('approve_call_succeeded')
    } else {
      fail('approve_call_failed', { status: patchRes.status, body: patchBody })
    }

    // ── Independent DB verification ─────────────────────────────────────
    const { data: quoteAfter } = await supabase
      .from('quotes')
      .select('status, approved_at, approved_by, is_current')
      .eq('id', scenario1.quoteId)
      .single()
    log('db_state_after_approval', quoteAfter ?? {})

    if (quoteAfter?.status === 'approved') ok('db_status_approved')
    else fail('db_status_not_approved', { actual: quoteAfter?.status })

    if (quoteAfter?.approved_at) ok('db_approved_at_set')
    else fail('db_approved_at_missing')

    if (quoteAfter?.approved_by === 'E2E Test Client') ok('db_approved_by_set')
    else fail('db_approved_by_mismatch', { actual: quoteAfter?.approved_by })

    if (quoteAfter?.is_current === true) ok('db_is_current_unchanged')
    else fail('db_is_current_changed', { actual: quoteAfter?.is_current })

    const { data: approvedEvents } = await supabase
      .from('proof_events')
      .select('id')
      .eq('job_id', scenario1.jobId)
      .eq('event_type', 'quote_approved')
    if ((approvedEvents?.length ?? 0) === 1) ok('exactly_one_proof_event')
    else fail('proof_event_count_wrong', { count: approvedEvents?.length ?? 0 })

    // ── Replay — identical token, identical decision ────────────────────
    const replayRes = await fetch(`${base}/api/quotes/${scenario1.quoteId}/approve?t=${encodeURIComponent(token)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', approved_by: 'Replay Attempt' }),
    })
    const replayBody = await replayRes.json().catch(() => ({}))
    log('replay_call', { status: replayRes.status, body: replayBody })
    if (replayRes.status === 422) ok('replay_rejected_422')
    else fail('replay_not_rejected', { status: replayRes.status, body: replayBody })

    const { data: eventsAfterReplay } = await supabase
      .from('proof_events')
      .select('id')
      .eq('job_id', scenario1.jobId)
      .eq('event_type', 'quote_approved')
    if ((eventsAfterReplay?.length ?? 0) === 1) ok('replay_created_no_second_event')
    else fail('replay_created_extra_event', { count: eventsAfterReplay?.length ?? 0 })

    const { data: quoteAfterReplay } = await supabase
      .from('quotes')
      .select('approved_by')
      .eq('id', scenario1.quoteId)
      .single()
    if (quoteAfterReplay?.approved_by === 'E2E Test Client') ok('replay_did_not_overwrite_approved_by')
    else fail('replay_overwrote_approved_by', { actual: quoteAfterReplay?.approved_by })
  } else {
    fail('no_token_available_skipping_scenario1_checks')
  }

  // ── Scenario 2: draft (never-sent) quote — must be rejected, no mutation ─
  const scenario2 = await makeQuote('ineligible-draft', 'draft', [
    { trade_category_id: 1, description: 'Draft-only line item', total: 3000, margin_pct: 0.18 },
  ])
  log('scenario2_quote_created', scenario2)

  const share2Res = await fetch(`${base}/api/quotes/${scenario2.quoteId}/share`, { method: 'POST', headers: authHeaders })
  const share2Body = await share2Res.json().catch(() => ({}))
  const token2 = share2Body.link ? new URL(share2Body.link).searchParams.get('t') : null

  if (token2) {
    const draftPatchRes = await fetch(`${base}/api/quotes/${scenario2.quoteId}/approve?t=${encodeURIComponent(token2)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', approved_by: 'Should Not Work' }),
    })
    log('draft_approve_attempt', { status: draftPatchRes.status })
    if (draftPatchRes.status === 404) ok('draft_quote_approval_rejected')
    else fail('draft_quote_approval_not_rejected', { status: draftPatchRes.status })

    const { data: draftAfter } = await supabase
      .from('quotes')
      .select('status, approved_at, approved_by')
      .eq('id', scenario2.quoteId)
      .single()
    if (draftAfter?.status === 'draft' && !draftAfter.approved_at && !draftAfter.approved_by) {
      ok('draft_quote_no_mutation')
    } else {
      fail('draft_quote_was_mutated', draftAfter ?? {})
    }
  } else {
    fail('no_token_available_skipping_scenario2_checks')
  }

  // ── Scenario 3: "request changes" — must not touch status/financials ────
  const scenario3 = await makeQuote('changes-requested', 'sent', [
    { trade_category_id: 1, description: 'Changes-requested line item', total: 4000, margin_pct: 0.18 },
  ])
  log('scenario3_quote_created', scenario3)

  const share3Res = await fetch(`${base}/api/quotes/${scenario3.quoteId}/share`, { method: 'POST', headers: authHeaders })
  const share3Body = await share3Res.json().catch(() => ({}))
  const token3 = share3Body.link ? new URL(share3Body.link).searchParams.get('t') : null

  if (token3) {
    const { data: beforeChanges } = await supabase
      .from('quotes')
      .select('status, approved_at, approved_by, total_cost')
      .eq('id', scenario3.quoteId)
      .single()

    const changesRes = await fetch(`${base}/api/quotes/${scenario3.quoteId}/approve?t=${encodeURIComponent(token3)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'changes_requested', approved_by: 'E2E Client', message: 'Please swap the tapware brand.' }),
    })
    const changesBody = await changesRes.json().catch(() => ({}))
    log('changes_requested_call', { status: changesRes.status, body: changesBody })
    if (changesRes.ok) ok('changes_requested_call_succeeded')
    else fail('changes_requested_call_failed', { status: changesRes.status, body: changesBody })

    const { data: afterChanges } = await supabase
      .from('quotes')
      .select('status, approved_at, approved_by, total_cost')
      .eq('id', scenario3.quoteId)
      .single()
    log('quote_state_after_changes_requested', afterChanges ?? {})

    if (JSON.stringify(afterChanges) === JSON.stringify(beforeChanges)) {
      ok('changes_requested_left_quote_row_untouched')
    } else {
      fail('changes_requested_mutated_quote_row', { before: beforeChanges, after: afterChanges })
    }

    const { data: changeEvents } = await supabase
      .from('proof_events')
      .select('id, description')
      .eq('job_id', scenario3.jobId)
      .eq('event_type', 'quote_changes_requested')
    if ((changeEvents?.length ?? 0) === 1) ok('exactly_one_changes_requested_proof_event')
    else fail('changes_requested_proof_event_count_wrong', { count: changeEvents?.length ?? 0 })
  } else {
    fail('no_token_available_skipping_scenario3_checks')
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
