#!/usr/bin/env node
// ============================================================
// WorkA — live end-to-end verification of Job Closeout v1 — Wire Existing
// Reconciliation to the Canonical Job Snapshot, driven through the ACTUAL
// deployed app routes (not direct DB writes for anything under test).
// ============================================================
// Same authenticated real-route pattern as run-manual-estimate-e2e.mjs,
// run-job-costs-e2e.mjs, run-variations-financial-e2e.mjs, and
// run-invoicing-financial-e2e.mjs: real fetch() calls to APP_URL,
// authenticated via the documented internal server-to-server path
// (lib/auth/api-auth.ts) — Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY +
// x-worka-builder-id.
//
// Model under test: this milestone did NOT touch POST /api/estimation/reconcile
// (app/api/estimation/reconcile/route.ts) — it only wires the existing
// endpoint into JobSnapshotPanel via CloseJobModal + lib/job-closeout.ts's
// buildReconciliationEntries. This script therefore calls the real reconcile
// route directly with an INDEPENDENTLY computed `entries` payload (built the
// same way CloseJobModal builds it — quote line items grouped by trade for
// estimated_cost, job_cost_entries grouped by trade for actual_cost — but
// recomputed here from scratch, not by importing lib/job-closeout.ts, so a
// bug in that module couldn't hide itself from this check) — proving the
// endpoint and the payload shape the new UI sends it both behave correctly,
// without needing a browser.
//
// Cleanup: project_memory.job_id is ON DELETE SET NULL (not CASCADE, see
// migration 011) — deleting the job would silently orphan the project_memory
// row instead of removing it, and cost_reconciliation cascades from
// project_memory, not from jobs. So project_memory is deleted explicitly by
// job_id BEFORE the job itself, in a `finally` block regardless of outcome.
// builder_estimation_profiles is builder-scoped (not job-scoped, unique per
// builder_id) — reset to absent both before setup (deterministic baseline for
// the accuracy/jobs_completed assertions) and after cleanup.
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
// (...f7, ...f8, ...f9, ...fc, ...fd, ...fe, ...ff already taken).
const BUILDER_ID = '00000000-0000-0000-0000-0000000000f6'
const OTHER_BUILDER_ID = '00000000-0000-0000-0000-0000000000f5'
const AUTH_HEADERS = { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'x-worka-builder-id': BUILDER_ID }
const OTHER_AUTH_HEADERS = { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'x-worka-builder-id': OTHER_BUILDER_ID }

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

async function fetchAs(headers, path, options = {}) {
  const url = `${APP_URL.replace(/\/$/, '')}${path}`
  const res = await fetch(url, { ...options, headers: { ...headers, 'Content-Type': 'application/json', ...(options.headers ?? {}) } })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON body, keep null */ }
  return { ok: res.ok, status: res.status, json, text }
}

const apiFetch = (path, options) => fetchAs(AUTH_HEADERS, path, options)
const otherFetch = (path, options) => fetchAs(OTHER_AUTH_HEADERS, path, options)

// Independently mirrors what CloseJobModal / lib/job-closeout.ts build —
// written fresh here rather than imported, so this script verifies the real
// behaviour rather than just re-running the same code under test.
function buildExpectedEntries(lineItemsByCategory, costRows) {
  const actualByTrade = new Map()
  for (const row of costRows) {
    if (row.trade_category_id === null) continue
    actualByTrade.set(row.trade_category_id, round2((actualByTrade.get(row.trade_category_id) ?? 0) + row.amount))
  }
  return lineItemsByCategory.map((c) => ({
    trade_category_id: c.category_id,
    estimated_cost: c.category_total,
    actual_cost: actualByTrade.has(c.category_id) ? actualByTrade.get(c.category_id) : null,
  }))
}

// Mirrors app/api/estimation/reconcile/route.ts's own accuracy formula exactly.
function expectedAccuracyPct(entries) {
  const totalEstimated = entries.reduce((s, e) => s + e.estimated_cost, 0)
  const totalActual = entries.reduce((s, e) => s + (e.actual_cost ?? e.estimated_cost), 0)
  if (totalEstimated <= 0) return null
  const pct = Math.max(0, 100 - Math.abs((totalActual - totalEstimated) / totalEstimated * 100))
  return Math.round(pct * 10) / 10
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const jobId = crypto.randomUUID()
  const otherJobId = crypto.randomUUID()
  const runTag = new Date().toISOString()
  const result = { job_id: jobId, other_job_id: otherJobId, passed: false }

  try {
    log('run_started', { job_id: jobId })

    await Promise.all([
      supabase.from('builders').upsert({ id: BUILDER_ID, email: 'closeout-e2e-check@getworka.com', name: 'Closeout E2E Check' }, { onConflict: 'id', ignoreDuplicates: true }),
      supabase.from('builders').upsert({ id: OTHER_BUILDER_ID, email: 'closeout-e2e-other-builder@getworka.com', name: 'Closeout E2E Other Builder' }, { onConflict: 'id', ignoreDuplicates: true }),
    ])

    // Deterministic baseline: this builder must start with no project_memory/
    // builder_estimation_profiles rows, since jobs_completed/accuracy checks
    // below assume this is the builder's first-ever reconciliation.
    await supabase.from('builder_estimation_profiles').delete().eq('builder_id', BUILDER_ID)
    const { data: priorMemory } = await supabase.from('project_memory').select('id').eq('builder_id', BUILDER_ID)
    if (priorMemory?.length) {
      await supabase.from('cost_reconciliation').delete().in('project_memory_id', priorMemory.map((m) => m.id))
      await supabase.from('project_memory').delete().eq('builder_id', BUILDER_ID)
    }

    const { error: jobErr } = await supabase.from('jobs').insert({
      id: jobId, builder_id: BUILDER_ID,
      address: `CLOSEOUT E2E CHECK — 8 Test Ave, Kew VIC (${runTag}), safe to delete`,
      status: 'active', job_type: 'health_check',
    })
    if (jobErr) throw new Error(`job insert failed: ${jobErr.message}`)

    const { error: otherJobErr } = await supabase.from('jobs').insert({
      id: otherJobId, builder_id: OTHER_BUILDER_ID,
      address: `CLOSEOUT E2E CHECK (other builder) — 9 Test Ave, Kew VIC (${runTag}), safe to delete`,
      status: 'active', job_type: 'health_check',
    })
    if (otherJobErr) throw new Error(`other job insert failed: ${otherJobErr.message}`)

    // Contract value: two trades, deliberately simple numbers.
    // Trade 2 (Framing): 50000. Trade 5 (Electrical): 20000. Baseline = 70000.
    const { data: quoteRow, error: quoteErr } = await supabase
      .from('quotes')
      .insert({ job_id: jobId, builder_id: BUILDER_ID, status: 'approved', total_cost: 70000, margin_pct: 0, version: 1 })
      .select('id').single()
    if (quoteErr || !quoteRow) throw new Error(`quote insert failed: ${quoteErr?.message}`)
    const quoteId = quoteRow.id

    const { error: liErr } = await supabase.from('quote_line_items').insert([
      { quote_id: quoteId, trade_category_id: 2, description: 'Framing — E2E baseline', quantity: 1, unit: 'item', rate: 50000, total: 50000, margin_pct: 0, confidence: 100, is_assumption: false },
      { quote_id: quoteId, trade_category_id: 5, description: 'Electrical — E2E baseline', quantity: 1, unit: 'item', rate: 20000, total: 20000, margin_pct: 0, confidence: 100, is_assumption: false },
    ])
    if (liErr) throw new Error(`baseline line items insert failed: ${liErr.message}`)

    // Actual-cost ledger (Financials v1): trade 2 gets two classified entries
    // (30000 total), trade 5 gets nothing logged yet, plus one UNCLASSIFIED
    // cost (no trade_category_id — e.g. a permit fee) that the reconciliation
    // schema cannot represent per-trade and must be excluded from `entries`,
    // never invented onto an arbitrary trade.
    const { error: costErr } = await supabase.from('job_cost_entries').insert([
      { job_id: jobId, builder_id: BUILDER_ID, trade_category_id: 2, description: 'Framing labour', amount: 20000, incurred_on: '2026-08-01' },
      { job_id: jobId, builder_id: BUILDER_ID, trade_category_id: 2, description: 'Framing materials', amount: 10000, incurred_on: '2026-08-05' },
      { job_id: jobId, builder_id: BUILDER_ID, trade_category_id: null, description: 'Council permit fee', amount: 1500, incurred_on: '2026-08-02' },
    ])
    if (costErr) throw new Error(`cost entries insert failed: ${costErr.message}`)

    // One invoice, sent — must be completely unaffected by closeout.
    const createInv = await apiFetch(`/api/jobs/${jobId}/invoices`, { method: 'POST', body: JSON.stringify({ description: 'Deposit', amount: 20000 }) })
    if (!createInv.ok) throw new Error(`invoice create failed: ${createInv.text}`)
    const invoiceId = createInv.json?.invoice?.id
    const sendInv = await apiFetch(`/api/jobs/${jobId}/invoices/${invoiceId}`, { method: 'PATCH', body: JSON.stringify({ action: 'send' }) })
    if (!sendInv.ok) throw new Error(`invoice send failed: ${sendInv.text}`)

    log('setup_complete', { job_id: jobId, quote_id: quoteId })

    // ── 1. Baseline snapshot — active, correct financials before closeout ──
    const snap0 = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    const ov0 = snap0.json?.snapshot?.overview
    check('baseline_status_active', snap0.json?.snapshot?.job?.status === 'active', { status: snap0.json?.snapshot?.job?.status })
    check('baseline_snapshot_correct', ov0?.contract_value === 70000 && ov0?.actual_cost === 31500 && ov0?.current_margin === 38500 && ov0?.invoiced === 20000, { overview: ov0 })

    // ── 2. Approve a variation before closing — must still be reflected ────
    const raiseVar = await apiFetch('/api/variations', { method: 'POST', body: JSON.stringify({ job_id: jobId, title: 'Extra GPOs', description: 'Client requested additional power points', amount: 8000, trade_category_id: 2 }) })
    check('raise_variation_ok', raiseVar.ok && !!raiseVar.json?.variation?.id, { status: raiseVar.status, body: raiseVar.json ?? raiseVar.text })
    const variationId = raiseVar.json?.variation?.id
    const approveVar = await apiFetch(`/api/variations/${variationId}/resolve`, { method: 'POST', body: JSON.stringify({ action: 'approved' }) })
    check('approve_variation_ok', approveVar.ok && approveVar.json?.contract_effect?.applied === true, { status: approveVar.status, contract_effect: approveVar.json?.contract_effect })

    const snapAfterVar = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    check('contract_value_reflects_variation_before_close', snapAfterVar.json?.snapshot?.overview?.contract_value === 78000, { expected: 78000, actual: snapAfterVar.json?.snapshot?.overview?.contract_value })

    // ── 3. Build the exact payload CloseJobModal would build, independently ──
    const quoteRes = await apiFetch(`/api/quotes/${quoteId}`)
    check('quote_fetch_ok', quoteRes.ok && Array.isArray(quoteRes.json?.line_items_by_category), { status: quoteRes.status })
    const lineItemsByCategory = quoteRes.json?.line_items_by_category ?? []
    check('line_items_by_category_includes_variation', lineItemsByCategory.find((c) => c.category_id === 2)?.category_total === 58000, { rows: lineItemsByCategory })

    const { data: costRows } = await supabase.from('job_cost_entries').select('trade_category_id, amount').eq('job_id', jobId)
    const entries = buildExpectedEntries(lineItemsByCategory, costRows ?? [])
    check('entries_built_correctly', JSON.stringify(entries.sort((a, b) => a.trade_category_id - b.trade_category_id)) === JSON.stringify([
      { trade_category_id: 2, estimated_cost: 58000, actual_cost: 30000 },
      { trade_category_id: 5, estimated_cost: 20000, actual_cost: null },
    ]), { entries })

    const overviewBeforeClose = snapAfterVar.json?.snapshot?.overview

    // ── 4. Close the job — calls the real, untouched reconcile endpoint ────
    const closeRes = await apiFetch('/api/estimation/reconcile', {
      method: 'POST',
      body: JSON.stringify({
        job_id: jobId, quote_id: quoteId, entries,
        final_cost: overviewBeforeClose.actual_cost, final_margin_pct: overviewBeforeClose.current_margin_pct,
      }),
    })
    check('close_ok', closeRes.ok && closeRes.json?.ok === true && closeRes.json?.already_reconciled !== true, { status: closeRes.status, body: closeRes.json })

    // ── 5. Job transitions to complete ──────────────────────────────────
    const { data: jobRowAfterClose } = await supabase.from('jobs').select('status').eq('id', jobId).single()
    check('job_status_complete', jobRowAfterClose?.status === 'complete', { row: jobRowAfterClose })

    const snapAfterClose = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    check('snapshot_job_status_complete', snapAfterClose.json?.snapshot?.job?.status === 'complete', { status: snapAfterClose.json?.snapshot?.job?.status })

    // ── 6. Financial records unchanged by closeout ─────────────────────
    check('contract_value_unchanged_by_close', snapAfterClose.json?.snapshot?.overview?.contract_value === 78000, { expected: 78000, actual: snapAfterClose.json?.snapshot?.overview?.contract_value })
    check('actual_cost_unchanged_by_close', snapAfterClose.json?.snapshot?.overview?.actual_cost === 31500, { expected: 31500, actual: snapAfterClose.json?.snapshot?.overview?.actual_cost })

    const { data: costRowsAfter } = await supabase.from('job_cost_entries').select('id, amount, trade_category_id').eq('job_id', jobId)
    check('job_cost_entries_unchanged', costRowsAfter?.length === 3 && round2(costRowsAfter.reduce((s, r) => s + r.amount, 0)) === 31500, { rows: costRowsAfter })

    const { data: invoiceRowAfter } = await supabase.from('invoices').select('status, amount, invoice_number').eq('id', invoiceId).single()
    check('invoice_unchanged_by_close', invoiceRowAfter?.status === 'sent' && invoiceRowAfter?.amount === 20000, { row: invoiceRowAfter })

    const { data: lineItemsAfter } = await supabase.from('quote_line_items').select('id, trade_category_id, total').eq('quote_id', quoteId)
    check('quote_line_items_unchanged_by_close', lineItemsAfter?.length === 3 && round2(lineItemsAfter.reduce((s, r) => s + r.total, 0)) === 78000, { rows: lineItemsAfter })

    // ── 7. cost_reconciliation rows created correctly (rate-learning signal) ──
    // Only entries with a non-null actual_cost are persisted (see reconcile
    // route) — trade 5 (actual_cost null) is intentionally NOT a row here.
    const { data: memoryRow } = await supabase.from('project_memory').select('id, status, final_cost, final_margin_pct').eq('job_id', jobId).single()
    check('project_memory_completed', memoryRow?.status === 'completed' && memoryRow?.final_cost === 31500, { row: memoryRow })

    const { data: reconRows } = await supabase.from('cost_reconciliation').select('trade_category_id, estimated_cost, actual_cost').eq('project_memory_id', memoryRow?.id)
    check('cost_reconciliation_rows_correct', reconRows?.length === 1 && reconRows[0].trade_category_id === 2 && Number(reconRows[0].estimated_cost) === 58000 && Number(reconRows[0].actual_cost) === 30000, { rows: reconRows })

    // ── 8. Rate-learning side effect: builder_estimation_profiles updated ──
    const expectedAccuracy = expectedAccuracyPct(entries)
    const { data: profileRow } = await supabase.from('builder_estimation_profiles').select('jobs_completed, avg_quote_accuracy_pct').eq('builder_id', BUILDER_ID).single()
    check('rate_learning_side_effect_occurred', profileRow?.jobs_completed === 1 && profileRow?.avg_quote_accuracy_pct === expectedAccuracy, { expected_accuracy: expectedAccuracy, row: profileRow })

    // ── 9. Repeat close attempt — idempotent, no duplicate reconciliation ──
    // Deliberately submits DIFFERENT entries (simulating the old, still-live
    // CloseOutJobDrawer's manual-re-entry path submitting different numbers
    // for the same job) to prove the backend's idempotency guard makes the
    // second call's payload irrelevant — this is the explicit "two closeout
    // UIs cannot conflict" check, not just a repeat of the same call.
    const conflictingEntries = [
      { trade_category_id: 2, estimated_cost: 58000, actual_cost: 999999 },
      { trade_category_id: 5, estimated_cost: 20000, actual_cost: 999999 },
    ]
    const repeatClose = await apiFetch('/api/estimation/reconcile', {
      method: 'POST',
      body: JSON.stringify({ job_id: jobId, quote_id: quoteId, entries: conflictingEntries }),
    })
    check('repeat_close_idempotent', repeatClose.ok && repeatClose.json?.already_reconciled === true, { status: repeatClose.status, body: repeatClose.json })

    const { data: reconRowsAfterRepeat } = await supabase.from('cost_reconciliation').select('trade_category_id, estimated_cost, actual_cost').eq('project_memory_id', memoryRow?.id)
    check('no_duplicate_reconciliation_rows', reconRowsAfterRepeat?.length === 1 && Number(reconRowsAfterRepeat[0].actual_cost) === 30000, { rows: reconRowsAfterRepeat })

    const { data: profileRowAfterRepeat } = await supabase.from('builder_estimation_profiles').select('jobs_completed, avg_quote_accuracy_pct').eq('builder_id', BUILDER_ID).single()
    check('jobs_completed_not_double_counted', profileRowAfterRepeat?.jobs_completed === 1 && profileRowAfterRepeat?.avg_quote_accuracy_pct === expectedAccuracy, { row: profileRowAfterRepeat })

    const { data: jobRowAfterRepeat } = await supabase.from('jobs').select('status').eq('id', jobId).single()
    check('job_status_still_complete_after_repeat', jobRowAfterRepeat?.status === 'complete', { row: jobRowAfterRepeat })

    // ── 10. Cross-builder access rejected ───────────────────────────────
    const crossAttempt = await otherFetch('/api/estimation/reconcile', {
      method: 'POST',
      body: JSON.stringify({ job_id: jobId, quote_id: quoteId, entries }),
    })
    check('cross_builder_close_blocked', !crossAttempt.ok && crossAttempt.status === 404, { status: crossAttempt.status, body: crossAttempt.json })

    const { data: memoryRowAfterCrossAttempt } = await supabase.from('project_memory').select('builder_id').eq('job_id', jobId).single()
    check('project_memory_builder_unchanged_after_cross_attempt', memoryRowAfterCrossAttempt?.builder_id === BUILDER_ID, { row: memoryRowAfterCrossAttempt })

    result.checks = checks
    result.passed = checks.every((c) => c.ok)
    log('run_finished', { job_id: jobId, passed: result.passed, checks_total: checks.length, checks_failed: checks.filter((c) => !c.ok).length })
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    result.checks = checks
    result.passed = false
    log('run_failed', { job_id: jobId, error: result.error })
  } finally {
    log('cleanup_started', { job_id: jobId })
    try {
      // project_memory.job_id is ON DELETE SET NULL — must delete explicitly
      // by job_id before the job itself, or the row (and its
      // cost_reconciliation children, which DO cascade from project_memory)
      // would be silently orphaned rather than removed.
      const { data: memoryRows } = await supabase.from('project_memory').select('id').eq('job_id', jobId)
      if (memoryRows?.length) {
        await supabase.from('cost_reconciliation').delete().in('project_memory_id', memoryRows.map((m) => m.id))
        await supabase.from('project_memory').delete().eq('job_id', jobId)
      }
      await supabase.from('builder_estimation_profiles').delete().eq('builder_id', BUILDER_ID)
      await supabase.from('jobs').delete().eq('id', jobId) // cascades quotes/quote_line_items/invoices/variations/job_cost_entries
      await supabase.from('jobs').delete().eq('id', otherJobId)

      // Verify cleanup — no disposable rows left behind.
      const { count: memoryLeft } = await supabase.from('project_memory').select('id', { count: 'exact', head: true }).eq('job_id', jobId)
      const { count: jobsLeft } = await supabase.from('jobs').select('id', { count: 'exact', head: true }).in('id', [jobId, otherJobId])
      const { count: profileLeft } = await supabase.from('builder_estimation_profiles').select('id', { count: 'exact', head: true }).eq('builder_id', BUILDER_ID)
      const cleanupVerified = (memoryLeft ?? 0) === 0 && (jobsLeft ?? 0) === 0 && (profileLeft ?? 0) === 0
      log(cleanupVerified ? 'cleanup_complete' : 'cleanup_INCOMPLETE', { job_id: jobId, other_job_id: otherJobId, memory_left: memoryLeft, jobs_left: jobsLeft, profile_left: profileLeft })
    } catch (cleanupErr) {
      log('cleanup_failed', { error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) })
    }
    log('final_result', result)
  }

  process.exit(result.passed ? 0 : 1)
}

main()
