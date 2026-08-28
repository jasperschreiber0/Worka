#!/usr/bin/env node
// ============================================================
// WorkA — Round 11 Finding #1 production E2E verification
// ============================================================
// Verifies the fix for: getContractValueForJob (lib/invoices.ts), the job
// snapshot route (app/api/jobs/[jobId]/snapshot/route.ts), and
// applyApprovedVariationToQuote (lib/variations.ts) now select a job's
// quote via `is_current = true` (quotes.is_current, migration 061) rather
// than "highest version, no tiebreak" — see the fix commit for the full
// reasoning.
//
// Deliberately constructs a divergent current/non-current quote state
// DIRECTLY in the DB (explicitly authorized for this E2E — this is not a
// state the fix could otherwise be proven against without it, since
// production currently has zero jobs with more than one quote): a job with
// two quotes —
//   Quote A: is_current=true,  version=1, line items totalling $100,000
//   Quote B: is_current=false, version=2 (higher version), $20,000
// — then drives the three consumers through the REAL deployed routes (not
// direct function calls) and confirms each one selects Quote A / $100,000,
// never Quote B / $20,000 (what the pre-fix "highest version" query would
// have picked).
//
// Cleanup: deletes every synthetic row in a `finally` block regardless of
// outcome. Full results are printed to stdout BEFORE cleanup runs.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL must all be set' }))
  process.exit(1)
}

// Reserved, next free id after the ...f1 ledger entry (Round 10).
const BUILDER_ID = '00000000-0000-0000-0000-0000000001f2'
const AUTH_HEADERS = { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'x-worka-builder-id': BUILDER_ID }

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

const checks = []
function check(name, ok, detail = {}) {
  checks.push({ name, ok, ...detail })
  log(ok ? 'check_passed' : 'check_FAILED', { name, ...detail })
  return ok
}

async function apiFetch(path, options = {}) {
  const url = `${APP_URL.replace(/\/$/, '')}${path}`
  const res = await fetch(url, {
    ...options,
    headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON body, keep null */ }
  return { ok: res.ok, status: res.status, json, text }
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const jobId = crypto.randomUUID()
  const quoteAId = crypto.randomUUID()
  const quoteBId = crypto.randomUUID()
  const runTag = new Date().toISOString()
  const result = { job_id: jobId, quote_a_id: quoteAId, quote_b_id: quoteBId, passed: false }

  try {
    log('run_started', { job_id: jobId })

    await supabase.from('builders').upsert(
      { id: BUILDER_ID, email: 'current-quote-consumers-e2e-check@getworka.com', name: 'Current Quote Consumers E2E Check' },
      { onConflict: 'id', ignoreDuplicates: true }
    )

    const { error: jobErr } = await supabase.from('jobs').insert({
      id: jobId,
      builder_id: BUILDER_ID,
      address: `ROUND 11 FINDING #1 E2E CHECK — synthetic job (${runTag}), safe to delete`,
      status: 'quoted',
      job_type: 'health_check',
    })
    if (jobErr) throw new Error(`job insert failed: ${jobErr.message}`)
    log('job_created', { job_id: jobId })

    // ── Construct the deliberately divergent quote state ────────────────
    // Quote A: is_current=true, LOWER version, approved — this is what
    // every consumer must select.
    const { error: quoteAErr } = await supabase.from('quotes').insert({
      id: quoteAId, job_id: jobId, builder_id: BUILDER_ID,
      status: 'approved', version: 1, is_current: true, margin_pct: 0.15,
      total_cost: 100000, confidence_score: 90,
    })
    if (quoteAErr) throw new Error(`quote A insert failed: ${quoteAErr.message}`)

    // Quote B: is_current=false, HIGHER version, draft — what the pre-fix
    // "highest version, no tiebreak" query would have picked instead.
    const { error: quoteBErr } = await supabase.from('quotes').insert({
      id: quoteBId, job_id: jobId, builder_id: BUILDER_ID,
      status: 'draft', version: 2, is_current: false, margin_pct: 0.15,
      total_cost: 20000, confidence_score: 90,
    })
    if (quoteBErr) throw new Error(`quote B insert failed: ${quoteBErr.message}`)
    log('divergent_quotes_created', { quote_a_id: quoteAId, quote_b_id: quoteBId })

    // Line items — margin_pct 0 so calculateClientPrice's sell total equals
    // `total` exactly, keeping the expected numbers exact ($100,000 /
    // $20,000) with no markup arithmetic to account for.
    const { error: lineAErr } = await supabase.from('quote_line_items').insert({
      quote_id: quoteAId, trade_category_id: 1, description: 'Quote A — current — the correct selection',
      quantity: 1, unit: 'item', rate: 100000, total: 100000, margin_pct: 0, confidence: 100,
      is_assumption: false, assumption_status: null, pricing_source: 'manual', predicted_by: 'human',
    })
    if (lineAErr) throw new Error(`quote A line item insert failed: ${lineAErr.message}`)

    const { error: lineBErr } = await supabase.from('quote_line_items').insert({
      quote_id: quoteBId, trade_category_id: 1, description: 'Quote B — non-current, higher version — must NOT be selected',
      quantity: 1, unit: 'item', rate: 20000, total: 20000, margin_pct: 0, confidence: 100,
      is_assumption: false, assumption_status: null, pricing_source: 'manual', predicted_by: 'human',
    })
    if (lineBErr) throw new Error(`quote B line item insert failed: ${lineBErr.message}`)
    log('line_items_created')

    // ── Consumer 1: getContractValueForJob, via GET /api/jobs/[jobId]/invoices ──
    const invoicesRes = await apiFetch(`/api/jobs/${jobId}/invoices`)
    check('invoices_route_ok', invoicesRes.ok, { status: invoicesRes.status, body: invoicesRes.json ?? invoicesRes.text })
    check('contract_value_selects_current_quote', invoicesRes.json?.contract_value === 100000, {
      expected: 100000, actual: invoicesRes.json?.contract_value,
      would_have_been_pre_fix: 20000,
    })

    // ── Consumer 2: job snapshot route, via GET /api/jobs/[jobId]/snapshot ──
    const snapshotRes = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    check('snapshot_route_ok', snapshotRes.ok, { status: snapshotRes.status, body: snapshotRes.json ?? snapshotRes.text })
    const snapshotQuoteId = snapshotRes.json?.snapshot?.quote?.id
    check('snapshot_selects_current_quote_id', snapshotQuoteId === quoteAId, {
      expected: quoteAId, actual: snapshotQuoteId, would_have_been_pre_fix: quoteBId,
    })
    const snapshotContractValue = snapshotRes.json?.snapshot?.overview?.contract_value
    check('snapshot_contract_value_matches_current_quote', snapshotContractValue === 100000, {
      expected: 100000, actual: snapshotContractValue,
    })

    // ── Consumer 3: applyApprovedVariationToQuote, via a real variation +
    // POST /api/variations/[variationId]/resolve {action:'approved'} ──────
    const createVariationRes = await apiFetch('/api/variations', {
      method: 'POST',
      body: JSON.stringify({
        job_id: jobId, title: 'Round 11 E2E variation', description: 'Synthetic variation for is_current verification',
        amount: 5000, trade_category_id: 1,
      }),
    })
    check('variation_created_ok', createVariationRes.ok && !!createVariationRes.json?.variation?.id, { status: createVariationRes.status, body: createVariationRes.json ?? createVariationRes.text })
    const variationId = createVariationRes.json?.variation?.id
    result.variation_id = variationId

    if (variationId) {
      const resolveRes = await apiFetch(`/api/variations/${variationId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ action: 'approved' }),
      })
      check('variation_resolve_ok', resolveRes.ok, { status: resolveRes.status, body: resolveRes.json ?? resolveRes.text })
      check('variation_applied_true', resolveRes.json?.contract_effect?.applied === true, { contract_effect: resolveRes.json?.contract_effect })
    }

    // ── Independent DB verification (separate from every app-level call above) ──
    const { data: variationLineItem, error: lineItemLookupErr } = await supabase
      .from('quote_line_items')
      .select('id, quote_id, description')
      .eq('variation_id', variationId)
      .maybeSingle()
    if (lineItemLookupErr) throw new Error(`variation line item lookup failed: ${lineItemLookupErr.message}`)
    check('db_variation_line_item_landed_on_current_quote', variationLineItem?.quote_id === quoteAId, {
      expected: quoteAId, actual: variationLineItem?.quote_id, would_have_been_pre_fix: quoteBId,
    })

    const { data: quoteBAfter, error: quoteBAfterErr } = await supabase
      .from('quote_line_items')
      .select('id')
      .eq('quote_id', quoteBId)
    if (quoteBAfterErr) throw new Error(`quote B post-check failed: ${quoteBAfterErr.message}`)
    check('db_quote_b_untouched', (quoteBAfter ?? []).length === 1, {
      expected_count: 1, actual_count: (quoteBAfter ?? []).length,
      note: 'Quote B must still have exactly its original line item — the variation must never have landed there',
    })

    const { data: quotesStillDivergent, error: divergeErr } = await supabase
      .from('quotes')
      .select('id, is_current, version')
      .eq('job_id', jobId)
    if (divergeErr) throw new Error(`quotes re-check failed: ${divergeErr.message}`)
    const currentRows = (quotesStillDivergent ?? []).filter((q) => q.is_current)
    check('db_exactly_one_current_quote', currentRows.length === 1 && currentRows[0].id === quoteAId, {
      current_rows: currentRows,
    })

    result.passed = checks.every((c) => c.ok)
    result.checks = checks
    log('final_result', result)
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    result.checks = checks
    log('run_failed', { job_id: jobId, error: result.error })
    log('final_result', result)
  } finally {
    // Cleanup — delete every synthetic row regardless of outcome.
    try {
      const variationId = result.variation_id
      if (variationId) {
        await supabase.from('quote_line_items').delete().eq('variation_id', variationId)
        await supabase.from('variations').delete().eq('id', variationId)
      }
      await supabase.from('quote_line_items').delete().in('quote_id', [quoteAId, quoteBId])
      await supabase.from('quotes').delete().in('id', [quoteAId, quoteBId])
      await supabase.from('jobs').delete().eq('id', jobId)
      log('cleanup_complete', { job_id: jobId })
    } catch (cleanupErr) {
      log('cleanup_FAILED', { job_id: jobId, error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) })
    }
  }

  process.exit(result.passed ? 0 : 1)
}

main()
