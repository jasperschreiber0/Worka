#!/usr/bin/env node
// ============================================================
// WorkA — live end-to-end verification of Financials v1 — Live Job Money,
// driven through the ACTUAL deployed app routes (not direct DB writes)
// ============================================================
// Same authenticated real-route pattern as run-manual-estimate-e2e.mjs:
// real fetch() calls to APP_URL, authenticated via the documented internal
// server-to-server path (lib/auth/api-auth.ts) — Authorization: Bearer
// $SUPABASE_SERVICE_ROLE_KEY + x-worka-builder-id.
//
// Covers:
//   1. Create a disposable job + a quote with real line items (so contract
//      value is non-trivial), via direct Supabase writes for setup only —
//      everything under test (costs CRUD, snapshot calculations) goes
//      through the real HTTP routes.
//   2. POST 3 cost entries via the real API.
//   3. GET returns them, ordered by incurred_on DESC.
//   4. Snapshot returns contract_value / actual_cost / current_margin /
//      current_margin_pct computed correctly — verified against the exact
//      expected numbers computed independently in this script.
//   5. Delete one cost; confirm actual_cost/margin/margin% all recalculate,
//      both via a fresh GET on the costs list and a fresh snapshot fetch.
//   6. Cross-job isolation: a second disposable job cannot see or delete
//      the first job's cost entries via the API, even when given the
//      first job's cost_id directly.
//   7. Snapshot integration: confirms JobSnapshotPanel's actual data source
//      (GET /api/jobs/[jobId]/snapshot) carries budget, estimated cost,
//      contract value, actual cost, current margin, and margin % together.
//
// This script does NOT touch the AI estimation pipeline at all — the quote
// used here is created directly (a real quotes/quote_line_items row set),
// not via /api/intake. Financials v1 has no AI-pipeline dependency, so
// there is nothing pipeline-related for this script to wait on or fail on.
//
// Cleanup: deletes both disposable jobs (cascades quotes/quote_line_items/
// job_cost_entries) in a `finally` block regardless of outcome.
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

// Reserved, distinct from every other script's builder id in this repo
// (...fc, ...fd, ...fe already taken).
const BUILDER_ID = '00000000-0000-0000-0000-0000000000ff'
const AUTH_HEADERS = { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'x-worka-builder-id': BUILDER_ID }

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

function round2(n) {
  return Math.round(n * 100) / 100
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const jobId = crypto.randomUUID()
  const otherJobId = crypto.randomUUID() // for the cross-job isolation check
  const runTag = new Date().toISOString()
  const result = { job_id: jobId, other_job_id: otherJobId, passed: false }

  try {
    log('run_started', { job_id: jobId })

    await supabase.from('builders').upsert(
      { id: BUILDER_ID, email: 'job-costs-e2e-check@getworka.com', name: 'Job Costs E2E Check' },
      { onConflict: 'id', ignoreDuplicates: true }
    )

    // ── Setup: main job, with a budget and a real priced quote (so contract
    // value is non-trivial and margin math is worth checking) ──────────────
    const { error: jobErr } = await supabase.from('jobs').insert({
      id: jobId,
      builder_id: BUILDER_ID,
      address: `JOB COSTS E2E CHECK — 21 Test St, Richmond VIC (${runTag}), safe to delete`,
      status: 'active',
      job_type: 'health_check',
      budget_estimate: 50000,
    })
    if (jobErr) throw new Error(`job insert failed: ${jobErr.message}`)

    const { data: quoteRow, error: quoteErr } = await supabase
      .from('quotes')
      .insert({ job_id: jobId, builder_id: BUILDER_ID, status: 'approved', total_cost: 36000, margin_pct: 0.15, version: 1 })
      .select('id')
      .single()
    if (quoteErr || !quoteRow) throw new Error(`quote insert failed: ${quoteErr?.message ?? 'no row'}`)
    const quoteId = quoteRow.id
    result.quote_id = quoteId

    // Two line items, cost 20000 + 16000 = 36000 (matches quote.total_cost,
    // though the snapshot route deliberately never reads that column for
    // contract value — this is what proves it's actually using the line
    // items, not just echoing quote.total_cost back). margin_pct 0.15 each.
    // calculateClientPrice: (20000*1.15) + (16000*1.15) = 23000 + 18400 = 41400.
    const { error: liErr } = await supabase.from('quote_line_items').insert([
      { quote_id: quoteId, trade_category_id: 2, description: 'Framing — E2E check', quantity: 1, unit: 'item', rate: 20000, total: 20000, margin_pct: 0.15, confidence: 100, is_assumption: false },
      { quote_id: quoteId, trade_category_id: 12, description: 'Electrical — E2E check', quantity: 1, unit: 'item', rate: 16000, total: 16000, margin_pct: 0.15, confidence: 100, is_assumption: false },
    ])
    if (liErr) throw new Error(`line item insert failed: ${liErr.message}`)

    const expectedContractValue = round2(20000 * 1.15 + 16000 * 1.15)
    log('setup_complete', { job_id: jobId, quote_id: quoteId, expected_contract_value: expectedContractValue })

    // Second, unrelated job for the cross-job isolation check — no costs of
    // its own, just needs to exist and belong to the SAME builder (the more
    // meaningful isolation check: same builder, different job, must still
    // be denied — a different-builder check would rely on a second reserved
    // test identity this repo's scripts don't otherwise provision).
    const { error: otherJobErr } = await supabase.from('jobs').insert({
      id: otherJobId,
      builder_id: BUILDER_ID,
      address: `JOB COSTS E2E CHECK — OTHER JOB (${runTag}), safe to delete`,
      status: 'active',
      job_type: 'health_check',
    })
    if (otherJobErr) throw new Error(`other job insert failed: ${otherJobErr.message}`)

    // ── Step 1: create 3 cost entries via the real API ──────────────────
    const costsToAdd = [
      { trade_category_id: 12, description: 'Electrical — First fix', amount: 4800, incurred_on: '2026-08-24' },
      { trade_category_id: 7, description: 'Plumber — Rough-in labour', amount: 2400, incurred_on: '2026-08-25' },
      { trade_category_id: null, description: 'Materials — Timber', amount: 1200.50, incurred_on: '2026-08-23' },
    ]
    const addedCostIds = {}
    for (const c of costsToAdd) {
      const res = await apiFetch(`/api/jobs/${jobId}/costs`, { method: 'POST', body: JSON.stringify(c) })
      const ok = check(`add_cost_ok:${c.description}`, res.ok && !!res.json?.cost_id, { status: res.status, body: res.json ?? res.text })
      if (ok) addedCostIds[c.description] = res.json.cost_id
    }

    // ── Step 2: GET returns them, ordered by incurred_on DESC ───────────
    const listRes = await apiFetch(`/api/jobs/${jobId}/costs`)
    check('list_returns_three', listRes.ok && listRes.json?.costs?.length === 3, { status: listRes.status, count: listRes.json?.costs?.length })
    const returnedDates = (listRes.json?.costs ?? []).map((c) => c.incurred_on)
    const sortedDesc = [...returnedDates].sort().reverse()
    check('list_ordered_by_incurred_on_desc', JSON.stringify(returnedDates) === JSON.stringify(sortedDesc), { returnedDates })

    // ── Step 3: cross-job isolation — the other job cannot see or delete
    // this job's cost entries, even with the real cost_id ────────────────
    const crossJobListRes = await apiFetch(`/api/jobs/${otherJobId}/costs`)
    const crossJobIds = (crossJobListRes.json?.costs ?? []).map((c) => c.id)
    check(
      'other_job_costs_list_does_not_include_this_jobs_entries',
      crossJobListRes.ok && Object.values(addedCostIds).every((id) => !crossJobIds.includes(id)),
      { other_job_cost_count: crossJobIds.length }
    )
    const firstCostId = Object.values(addedCostIds)[0]
    const crossJobDeleteRes = await apiFetch(`/api/jobs/${otherJobId}/costs/${firstCostId}`, { method: 'DELETE' })
    check('cross_job_delete_rejected', !crossJobDeleteRes.ok && crossJobDeleteRes.status === 404, { status: crossJobDeleteRes.status, body: crossJobDeleteRes.json ?? crossJobDeleteRes.text })
    // Confirm it genuinely survived — a real DB read, not just trusting the HTTP status.
    const { data: survivedRow } = await supabase.from('job_cost_entries').select('id').eq('id', firstCostId).maybeSingle()
    check('cost_entry_survived_cross_job_delete_attempt', !!survivedRow, { row: survivedRow })

    // ── Step 4: calculation — actual cost, contract value, margin, margin% ──
    const expectedActualCost = round2(costsToAdd.reduce((s, c) => s + c.amount, 0)) // 8400.50
    const snapshotRes1 = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    const overview1 = snapshotRes1.json?.snapshot?.overview
    check('snapshot_ok', snapshotRes1.ok && !!overview1, { status: snapshotRes1.status })
    check('actual_cost_equals_sum_of_entries', overview1?.actual_cost === expectedActualCost, { expected: expectedActualCost, actual: overview1?.actual_cost })
    check('contract_value_correct', overview1?.contract_value === expectedContractValue, { expected: expectedContractValue, actual: overview1?.contract_value })
    const expectedMargin1 = round2(expectedContractValue - expectedActualCost)
    check('current_margin_correct', overview1?.current_margin === expectedMargin1, { expected: expectedMargin1, actual: overview1?.current_margin })
    const expectedMarginPct1 = Math.round((expectedMargin1 / expectedContractValue) * 100)
    check('current_margin_pct_correct', overview1?.current_margin_pct === expectedMarginPct1, { expected: expectedMarginPct1, actual: overview1?.current_margin_pct })

    // ── Step 5: persistence — independent GET/snapshot after a delay ────
    await sleep(2_000)
    const listRes2 = await apiFetch(`/api/jobs/${jobId}/costs`)
    check('persists_across_refresh_list', listRes2.ok && listRes2.json?.costs?.length === 3, { count: listRes2.json?.costs?.length })
    const snapshotRes2 = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    const overview2 = snapshotRes2.json?.snapshot?.overview
    check('persists_across_refresh_snapshot', overview2?.actual_cost === expectedActualCost && overview2?.current_margin === expectedMargin1, { overview: overview2 })

    // ── Step 6: mutation — delete one, confirm everything recalculates ──
    const materialsId = addedCostIds['Materials — Timber']
    const deleteRes = await apiFetch(`/api/jobs/${jobId}/costs/${materialsId}`, { method: 'DELETE' })
    check('delete_cost_ok', deleteRes.ok && deleteRes.json?.deleted === true, { status: deleteRes.status, body: deleteRes.json ?? deleteRes.text })

    const listRes3 = await apiFetch(`/api/jobs/${jobId}/costs`)
    check('two_costs_remain_after_delete', listRes3.ok && listRes3.json?.costs?.length === 2, { count: listRes3.json?.costs?.length })

    const expectedActualCost2 = round2(4800 + 2400) // 7200.00
    const snapshotRes3 = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    const overview3 = snapshotRes3.json?.snapshot?.overview
    check('actual_cost_decreases_correctly_after_delete', overview3?.actual_cost === expectedActualCost2, { expected: expectedActualCost2, actual: overview3?.actual_cost })
    const expectedMargin2 = round2(expectedContractValue - expectedActualCost2)
    check('margin_increases_correctly_after_delete', overview3?.current_margin === expectedMargin2 && expectedMargin2 > expectedMargin1, { expected: expectedMargin2, actual: overview3?.current_margin, previous: expectedMargin1 })
    const expectedMarginPct2 = Math.round((expectedMargin2 / expectedContractValue) * 100)
    check('margin_pct_recalculates_correctly_after_delete', overview3?.current_margin_pct === expectedMarginPct2, { expected: expectedMarginPct2, actual: overview3?.current_margin_pct })

    // ── Step 7: snapshot integration — the single shared source
    // JobSnapshotPanel (desktop /jobs/[jobId], chat side panel, and
    // MobileJobSheet which wraps it directly) all read from ─────────────
    check(
      'snapshot_carries_all_six_money_fields',
      snapshotRes3.json?.snapshot?.job?.budget_estimate === 50000 &&
      snapshotRes3.json?.snapshot?.quote?.total_cost === 36000 &&
      overview3?.contract_value === expectedContractValue &&
      overview3?.actual_cost === expectedActualCost2 &&
      overview3?.current_margin === expectedMargin2 &&
      overview3?.current_margin_pct === expectedMarginPct2,
      {
        budget: snapshotRes3.json?.snapshot?.job?.budget_estimate,
        estimated_cost: snapshotRes3.json?.snapshot?.quote?.total_cost,
        contract_value: overview3?.contract_value,
        actual_cost: overview3?.actual_cost,
        current_margin: overview3?.current_margin,
        current_margin_pct: overview3?.current_margin_pct,
      }
    )

    result.checks = checks
    result.passed = checks.every((c) => c.ok)
    log('run_finished', { job_id: jobId, passed: result.passed, checks_total: checks.length, checks_failed: checks.filter((c) => !c.ok).length })
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    result.checks = checks
    result.passed = false
    log('run_failed', { job_id: jobId, error: result.error })
  } finally {
    log('final_result', result)
    try {
      await supabase.from('jobs').delete().eq('id', jobId) // cascades quotes/quote_line_items/job_cost_entries
      await supabase.from('jobs').delete().eq('id', otherJobId)
      log('cleanup_complete', { job_id: jobId, other_job_id: otherJobId })
    } catch (cleanupErr) {
      log('cleanup_failed', { error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) })
    }
  }

  process.exit(result.passed ? 0 : 1)
}

main()
