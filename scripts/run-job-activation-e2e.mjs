#!/usr/bin/env node
// ============================================================
// WorkA — live end-to-end verification of the job-activation reliability
// fix (POST /api/jobs/[jobId]/activate), driven through the ACTUAL
// deployed app route (not direct DB writes for anything under test).
// ============================================================
// Same authenticated real-route pattern as run-job-costs-e2e.mjs,
// run-variations-financial-e2e.mjs, run-invoicing-financial-e2e.mjs, and
// run-job-closeout-e2e.mjs: real fetch() calls to APP_URL, authenticated
// via Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY + x-worka-builder-id.
//
// Root cause under test: activate/route.ts's downstream writes (quote
// approval, job_milestones insert, invoice_schedule insert) were
// previously unchecked -- a mid-sequence failure could leave
// jobs.status='active' with none of them persisted, while still returning
// 200. Because the jobs.status claim is one-shot/forward-only, a naive
// retry could never re-claim the job to fix that. The fix
// (lib/job-activation.ts's planActivationRepair) resumes ONLY the missing
// steps for a demonstrably incomplete activation, using real DB state
// (quotes.is_current, quotes.status, job_milestones/invoice_schedule
// existence) -- never a blind "re-run everything" repair.
//
// Forced-failure methodology note (read before trusting the "failure"
// tests): a genuine, schema-safe, deterministic Postgres constraint
// violation could not be found for the quote-approval UPDATE or the
// job_milestones INSERT specifically -- job_milestones' only NOT NULL
// columns (title/description) come from static app-code templates never
// influenced by external test data, and calculateClientPrice/
// calculateSellTotal are deliberately null-safe (never produce NaN from
// externally-controllable inputs), so no live write-failure could be
// triggered for those two writes without modifying schema or app code,
// both explicitly out of scope for this fix. Instead, this script
// constructs -- directly, via disposable rows, not via timing or a
// simulated network failure -- the EXACT partial DB state each of those
// failures would leave behind (job already 'active', with one or two of
// {quote approved, milestones, invoice_schedule} deliberately absent), and
// verifies the route's repair path completes only the missing piece(s)
// without duplicating what already exists. This exercises the identical
// code branches a live failure would hit, deterministically. See the
// PASS/BLOCKED summary in the final report for this distinction spelled
// out plainly rather than overclaimed.
//
// Cleanup: deletes every disposable job (cascades quotes/quote_line_items/
// job_milestones/invoice_schedule) in a `finally` block regardless of
// outcome.
//
// Scenarios H and I (Round 9 fix) extend this to the zero-value invoice-
// schedule persistence-truthfulness defect: activate/route.ts's contract-
// value read (quote_line_items -> calculateClientPrice) used to be
// unchecked, so a transient failure silently computed a $0 contract value
// and every invoice_schedule row generated from it was inserted at
// amount:0 — and because the old repair check only counted rows, five real
// $0 rows read as "already done," permanently hiding the poisoned state.
// Scenario H constructs that exact state directly (not via a simulated
// failure) and verifies activate/route.ts now detects and REPLACES it
// (never duplicates alongside it, never touches milestones, converges to
// the normal idempotent 409 afterward). Scenario I confirms the same
// poisoned shape is left untouched if any of its rows is already linked to
// a real invoice — the repair's own independent safety guard.
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

// Reserved, distinct from every other script's builder id in this repo.
const BUILDER_ID = '00000000-0000-0000-0000-0000000000f4'
const OTHER_BUILDER_ID = '00000000-0000-0000-0000-0000000000f3'
const AUTH_HEADERS = { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'x-worka-builder-id': BUILDER_ID }
const OTHER_AUTH_HEADERS = { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'x-worka-builder-id': OTHER_BUILDER_ID }

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
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

const MILESTONE_TITLES = [
  'Contract signed', 'Site prep & demolition complete', 'Rough-in complete — plumbing & electrical',
  'Frame inspection passed', 'Lock-up achieved', 'Fix-out complete', 'Practical completion', 'Final inspection passed',
]
const INVOICE_LABELS = ['Deposit', 'Frame stage', 'Lock-up', 'Fix-out', 'Completion']
const INVOICE_PERCENTAGES = [10, 20, 25, 25, 20]

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const runTag = new Date().toISOString()
  const jobIds = {}
  const result = { passed: false, job_ids: jobIds }

  // Helpers ------------------------------------------------------------

  async function makeJob(label, status) {
    const id = crypto.randomUUID()
    const { error } = await supabase.from('jobs').insert({
      id, builder_id: BUILDER_ID,
      address: `ACTIVATION E2E CHECK — ${label} (${runTag}), safe to delete`,
      status, job_type: 'health_check',
    })
    if (error) throw new Error(`${label} job insert failed: ${error.message}`)
    jobIds[label] = id
    return id
  }

  async function makeQuote(jobId, { quoteStatus, isCurrent }) {
    const { data, error } = await supabase.from('quotes')
      .insert({ job_id: jobId, builder_id: BUILDER_ID, status: quoteStatus, total_cost: 100000, margin_pct: 0.2, version: 1, is_current: isCurrent })
      .select('id').single()
    if (error || !data) throw new Error(`quote insert failed: ${error?.message}`)
    // One line item so calculateClientPrice has real data to work from —
    // total_cost 100000 at 20% margin -> client price 120000.
    const { error: liErr } = await supabase.from('quote_line_items').insert({
      quote_id: data.id, trade_category_id: 2, description: 'Framing — E2E baseline',
      quantity: 1, unit: 'item', rate: 100000, total: 100000, margin_pct: 0.2, confidence: 100, is_assumption: false,
    })
    if (liErr) throw new Error(`line item insert failed: ${liErr.message}`)
    return data.id
  }

  async function seedMilestones(jobId) {
    const rows = MILESTONE_TITLES.map((title, i) => ({
      id: crypto.randomUUID(), job_id: jobId, builder_id: BUILDER_ID, title,
      description: null, due_date: null, completed_at: null, sort_order: i + 1,
    }))
    const { error } = await supabase.from('job_milestones').insert(rows)
    if (error) throw new Error(`seed milestones failed: ${error.message}`)
    return rows.map((r) => r.id)
  }

  async function seedSchedule(jobId) {
    const rows = INVOICE_LABELS.map((label, i) => ({
      id: crypto.randomUUID(), job_id: jobId, builder_id: BUILDER_ID, label,
      percentage: INVOICE_PERCENTAGES[i], amount: 120000 * INVOICE_PERCENTAGES[i] / 100, due_trigger: 'test', invoice_id: null,
    }))
    const { error } = await supabase.from('invoice_schedule').insert(rows)
    if (error) throw new Error(`seed schedule failed: ${error.message}`)
    return rows.map((r) => r.id)
  }

  // Round 9 fix: constructs the EXACT poisoned state a transient failure of
  // activate/route.ts's quote_line_items read used to leave behind — real
  // schedule rows, correct count, but every amount $0 against a genuinely
  // non-zero (120000) contract. Not a simulated failure; the DB state a
  // real one would produce.
  async function seedZeroSchedule(jobId, { linkedInvoiceId } = {}) {
    const rows = INVOICE_LABELS.map((label, i) => ({
      id: crypto.randomUUID(), job_id: jobId, builder_id: BUILDER_ID, label,
      percentage: INVOICE_PERCENTAGES[i], amount: 0, due_trigger: 'test',
      invoice_id: i === 0 ? (linkedInvoiceId ?? null) : null,
    }))
    const { error } = await supabase.from('invoice_schedule').insert(rows)
    if (error) throw new Error(`seed zero schedule failed: ${error.message}`)
    return rows.map((r) => r.id)
  }

  async function countAndIds(table, jobId) {
    const { data, error } = await supabase.from(table).select('id').eq('job_id', jobId)
    if (error) throw new Error(`${table} read failed: ${error.message}`)
    return { count: data.length, ids: new Set(data.map((r) => r.id)) }
  }

  try {
    log('run_started', {})

    await supabase.from('builders').upsert([
      { id: BUILDER_ID, email: 'activation-e2e-check@getworka.com', name: 'Activation E2E Check' },
      { id: OTHER_BUILDER_ID, email: 'activation-e2e-other-builder@getworka.com', name: 'Activation E2E Other Builder' },
    ], { onConflict: 'id', ignoreDuplicates: true })

    // ── Scenario A: normal fresh activation ──────────────────────────
    const jobA = await makeJob('fresh', 'quoted')
    const quoteA = await makeQuote(jobA, { quoteStatus: 'sent', isCurrent: true })

    const resA = await apiFetch(`/api/jobs/${jobA}/activate`, { method: 'POST', body: JSON.stringify({ quote_id: quoteA }) })
    check('fresh_activation_ok', resA.ok && resA.json?.job?.status === 'active', { status: resA.status, body: resA.json ?? resA.text })

    // Independent DB verification — never trust the response body alone.
    const { data: jobARow } = await supabase.from('jobs').select('status').eq('id', jobA).single()
    const { data: quoteARow } = await supabase.from('quotes').select('status').eq('id', quoteA).single()
    const msA = await countAndIds('job_milestones', jobA)
    const schedA = await countAndIds('invoice_schedule', jobA)
    check('fresh_db_state_correct', jobARow?.status === 'active' && quoteARow?.status === 'approved' && msA.count === 8 && schedA.count === 5, {
      job_status: jobARow?.status, quote_status: quoteARow?.status, milestone_count: msA.count, schedule_count: schedA.count,
    })

    const { data: milestoneTitlesA } = await supabase.from('job_milestones').select('title, sort_order').eq('job_id', jobA).order('sort_order')
    check('fresh_milestone_titles_match_template', JSON.stringify((milestoneTitlesA ?? []).map((m) => m.title)) === JSON.stringify(MILESTONE_TITLES), { titles: milestoneTitlesA })

    const { data: scheduleAmountsA } = await supabase.from('invoice_schedule').select('amount').eq('job_id', jobA)
    const scheduleSumA = (scheduleAmountsA ?? []).reduce((s, r) => s + Number(r.amount), 0)
    check('fresh_schedule_sums_to_client_contract_value', Math.round(scheduleSumA) === 120000, { expected: 120000, actual: scheduleSumA })

    // Repeat call on a now-fully-activated job — unchanged idempotent 409, no duplication.
    const repeatA = await apiFetch(`/api/jobs/${jobA}/activate`, { method: 'POST', body: JSON.stringify({ quote_id: quoteA }) })
    check('repeat_on_fully_active_job_rejected', !repeatA.ok && repeatA.status === 409, { status: repeatA.status, body: repeatA.json })
    const msAAfterRepeat = await countAndIds('job_milestones', jobA)
    const schedAAfterRepeat = await countAndIds('invoice_schedule', jobA)
    check('repeat_on_fully_active_job_no_duplication', msAAfterRepeat.count === 8 && schedAAfterRepeat.count === 5, { milestone_count: msAAfterRepeat.count, schedule_count: schedAAfterRepeat.count })

    // ── Scenario B: constructed partial state — quote approval missing ──
    // (the exact DB state a failed/unchecked quote-approval write used to leave behind)
    const jobB = await makeJob('quote-missing', 'active')
    const quoteB = await makeQuote(jobB, { quoteStatus: 'sent', isCurrent: true })
    const msIdsB = await seedMilestones(jobB)
    const schedIdsB = await seedSchedule(jobB)

    const resB = await apiFetch(`/api/jobs/${jobB}/activate`, { method: 'POST', body: JSON.stringify({ quote_id: quoteB }) })
    check('repair_quote_approval_ok', resB.ok, { status: resB.status, body: resB.json ?? resB.text })
    const { data: quoteBRow } = await supabase.from('quotes').select('status').eq('id', quoteB).single()
    check('repair_quote_approval_persisted', quoteBRow?.status === 'approved', { row: quoteBRow })
    const msB = await countAndIds('job_milestones', jobB)
    const schedB = await countAndIds('invoice_schedule', jobB)
    check('repair_quote_approval_did_not_duplicate_milestones_or_schedule', msB.count === 8 && schedB.count === 5 && setsEqual(msB.ids, new Set(msIdsB)) && setsEqual(schedB.ids, new Set(schedIdsB)), {
      milestone_count: msB.count, schedule_count: schedB.count,
    })

    // ── Scenario C: constructed partial state — milestones missing ──────
    const jobC = await makeJob('milestones-missing', 'active')
    const quoteC = await makeQuote(jobC, { quoteStatus: 'approved', isCurrent: true })
    const schedIdsC = await seedSchedule(jobC)

    const resC = await apiFetch(`/api/jobs/${jobC}/activate`, { method: 'POST', body: JSON.stringify({ quote_id: quoteC }) })
    check('repair_milestones_ok', resC.ok, { status: resC.status, body: resC.json ?? resC.text })
    const msC = await countAndIds('job_milestones', jobC)
    const schedC = await countAndIds('invoice_schedule', jobC)
    check('repair_milestones_created_schedule_not_duplicated', msC.count === 8 && schedC.count === 5 && setsEqual(schedC.ids, new Set(schedIdsC)), {
      milestone_count: msC.count, schedule_count: schedC.count,
    })

    // ── Scenario D: constructed partial state — invoice schedule missing ─
    const jobD = await makeJob('schedule-missing', 'active')
    const quoteD = await makeQuote(jobD, { quoteStatus: 'approved', isCurrent: true })
    const msIdsD = await seedMilestones(jobD)

    const resD = await apiFetch(`/api/jobs/${jobD}/activate`, { method: 'POST', body: JSON.stringify({ quote_id: quoteD }) })
    check('repair_schedule_ok', resD.ok, { status: resD.status, body: resD.json ?? resD.text })
    const msD = await countAndIds('job_milestones', jobD)
    const schedD = await countAndIds('invoice_schedule', jobD)
    check('repair_schedule_created_milestones_not_duplicated', msD.count === 8 && schedD.count === 5 && setsEqual(msD.ids, new Set(msIdsD)), {
      milestone_count: msD.count, schedule_count: schedD.count,
    })

    // ── Scenario E: fully-complete job — unchanged idempotent 409 ───────
    const jobE = await makeJob('fully-complete', 'active')
    const quoteE = await makeQuote(jobE, { quoteStatus: 'approved', isCurrent: true })
    const msIdsE = await seedMilestones(jobE)
    const schedIdsE = await seedSchedule(jobE)

    const resE = await apiFetch(`/api/jobs/${jobE}/activate`, { method: 'POST', body: JSON.stringify({ quote_id: quoteE }) })
    check('fully_complete_job_rejected_unchanged', !resE.ok && resE.status === 409, { status: resE.status, body: resE.json })
    const msE = await countAndIds('job_milestones', jobE)
    const schedE = await countAndIds('invoice_schedule', jobE)
    check('fully_complete_job_no_writes', setsEqual(msE.ids, new Set(msIdsE)) && setsEqual(schedE.ids, new Set(schedIdsE)), { milestone_count: msE.count, schedule_count: schedE.count })

    // ── Scenario F: non-canonical quote on an active job — declines repair, unchanged 409 ──
    const jobF = await makeJob('non-current-quote', 'active')
    const quoteFCurrent = await makeQuote(jobF, { quoteStatus: 'approved', isCurrent: true })
    await seedMilestones(jobF)
    await seedSchedule(jobF)
    // A second, non-current quote for the same job (e.g. a superseded draft) — must never trigger repair.
    const { data: quoteFStale } = await supabase.from('quotes')
      .insert({ job_id: jobF, builder_id: BUILDER_ID, status: 'sent', total_cost: 50000, margin_pct: 0.2, version: 2, is_current: false })
      .select('id').single()

    const resF = await apiFetch(`/api/jobs/${jobF}/activate`, { method: 'POST', body: JSON.stringify({ quote_id: quoteFStale.id }) })
    check('non_current_quote_declines_repair', !resF.ok && resF.status === 409, { status: resF.status, body: resF.json })
    const { data: quoteFStaleRow } = await supabase.from('quotes').select('status').eq('id', quoteFStale.id).single()
    check('non_current_quote_untouched', quoteFStaleRow?.status === 'sent', { row: quoteFStaleRow })
    void quoteFCurrent

    // ── Scenario H (Round 9 fix): poisoned $0 schedule against a genuinely
    // non-zero contract — must be REPLACED, not left alone, and not
    // duplicated alongside. ─────────────────────────────────────────────
    const jobH = await makeJob('poisoned-zero-schedule', 'active')
    const quoteH = await makeQuote(jobH, { quoteStatus: 'approved', isCurrent: true }) // client price 120000
    const msIdsH = await seedMilestones(jobH)
    const poisonedSchedIdsH = await seedZeroSchedule(jobH)

    const { data: poisonedRowsH } = await supabase.from('invoice_schedule').select('amount').eq('job_id', jobH)
    check('poisoned_schedule_seeded_at_zero', (poisonedRowsH ?? []).every((r) => Number(r.amount) === 0), { rows: poisonedRowsH })

    const resH = await apiFetch(`/api/jobs/${jobH}/activate`, { method: 'POST', body: JSON.stringify({ quote_id: quoteH }) })
    check('poisoned_schedule_repair_ok', resH.ok, { status: resH.status, body: resH.json ?? resH.text })

    const schedH = await countAndIds('invoice_schedule', jobH)
    check('poisoned_schedule_repair_no_duplication', schedH.count === 5, { schedule_count: schedH.count })
    check('poisoned_schedule_repair_replaced_not_appended', !setsEqual(schedH.ids, new Set(poisonedSchedIdsH)) && [...schedH.ids].every((id) => !poisonedSchedIdsH.includes(id)), {
      old_ids: poisonedSchedIdsH, new_ids: [...schedH.ids],
    })

    const { data: scheduleAmountsH } = await supabase.from('invoice_schedule').select('amount').eq('job_id', jobH)
    const scheduleSumH = (scheduleAmountsH ?? []).reduce((s, r) => s + Number(r.amount), 0)
    check('poisoned_schedule_repaired_to_correct_contract_value', Math.round(scheduleSumH) === 120000, { expected: 120000, actual: scheduleSumH })

    const msH = await countAndIds('job_milestones', jobH)
    check('poisoned_schedule_repair_did_not_touch_milestones', msH.count === 8 && setsEqual(msH.ids, new Set(msIdsH)), { milestone_count: msH.count })

    // Repeat call — the repaired schedule now reads as healthy, so this
    // must converge to the unchanged idempotent 409, not repeat the repair.
    const repeatH = await apiFetch(`/api/jobs/${jobH}/activate`, { method: 'POST', body: JSON.stringify({ quote_id: quoteH }) })
    check('poisoned_schedule_repair_converges_to_409_on_retry', !repeatH.ok && repeatH.status === 409, { status: repeatH.status, body: repeatH.json })
    const schedHAfterRepeat = await countAndIds('invoice_schedule', jobH)
    check('poisoned_schedule_repair_idempotent_no_further_mutation', schedHAfterRepeat.count === 5 && setsEqual(schedHAfterRepeat.ids, schedH.ids), { schedule_count: schedHAfterRepeat.count })

    // ── Scenario I (Round 9 fix): a $0 schedule row already linked to a
    // real invoice must NEVER be repaired — declines, unchanged 409. ────
    const jobI = await makeJob('poisoned-schedule-with-real-invoice', 'active')
    const quoteI = await makeQuote(jobI, { quoteStatus: 'approved', isCurrent: true })
    await seedMilestones(jobI)
    const { data: realInvoiceI, error: realInvoiceIErr } = await supabase.from('invoices')
      .insert({ job_id: jobI, builder_id: BUILDER_ID, amount: 500, status: 'draft' })
      .select('id').single()
    if (realInvoiceIErr || !realInvoiceI) throw new Error(`real invoice insert failed: ${realInvoiceIErr?.message}`)
    const poisonedSchedIdsI = await seedZeroSchedule(jobI, { linkedInvoiceId: realInvoiceI.id })

    const resI = await apiFetch(`/api/jobs/${jobI}/activate`, { method: 'POST', body: JSON.stringify({ quote_id: quoteI }) })
    check('poisoned_schedule_with_linked_invoice_declines_repair', !resI.ok && resI.status === 409, { status: resI.status, body: resI.json })
    const schedI = await countAndIds('invoice_schedule', jobI)
    check('poisoned_schedule_with_linked_invoice_untouched', schedI.count === 5 && setsEqual(schedI.ids, new Set(poisonedSchedIdsI)), { schedule_count: schedI.count })

    // ── Scenario G: cross-builder access rejected ────────────────────────
    const crossAttempt = await otherFetch(`/api/jobs/${jobA}/activate`, { method: 'POST', body: JSON.stringify({ quote_id: quoteA }) })
    check('cross_builder_activate_blocked', !crossAttempt.ok && (crossAttempt.status === 404 || crossAttempt.status === 403), { status: crossAttempt.status, body: crossAttempt.json })

    result.checks = checks
    result.passed = checks.every((c) => c.ok)
    log('run_finished', { passed: result.passed, checks_total: checks.length, checks_failed: checks.filter((c) => !c.ok).length })
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    result.checks = checks
    result.passed = false
    log('run_failed', { error: result.error })
  } finally {
    log('cleanup_started', {})
    try {
      const ids = Object.values(jobIds)
      if (ids.length) {
        // Unlink + delete invoices FIRST — invoice_schedule.invoice_id has no
        // ON DELETE clause (NO ACTION), so cascading the job delete straight
        // through both invoice_schedule.job_id and invoices.job_id at once
        // risks the exact FK-ordering hazard a prior audit round flagged in
        // the app's own invoice DELETE route. Doing it explicitly here,
        // correctly, sidesteps relying on unspecified cascade ordering.
        await supabase.from('invoice_schedule').update({ invoice_id: null }).in('job_id', ids)
        await supabase.from('invoices').delete().in('job_id', ids)
      }
      if (ids.length) await supabase.from('jobs').delete().in('id', ids) // cascades quotes/quote_line_items/job_milestones/invoice_schedule
      const { count: jobsLeft } = await supabase.from('jobs').select('id', { count: 'exact', head: true }).in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
      log((jobsLeft ?? 0) === 0 ? 'cleanup_complete' : 'cleanup_INCOMPLETE', { jobs_left: jobsLeft })
    } catch (cleanupErr) {
      log('cleanup_failed', { error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) })
    }
    log('final_result', result)
  }

  process.exit(result.passed ? 0 : 1)
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

main()
