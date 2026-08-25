#!/usr/bin/env node
// ============================================================
// WorkA — live end-to-end verification of Invoicing v1 — Real Cash
// Tracking, driven through the ACTUAL deployed app routes (not direct DB
// writes for anything under test).
// ============================================================
// Same authenticated real-route pattern as run-manual-estimate-e2e.mjs,
// run-job-costs-e2e.mjs, and run-variations-financial-e2e.mjs: real fetch()
// calls to APP_URL, authenticated via the documented internal
// server-to-server path (lib/auth/api-auth.ts) — Authorization: Bearer
// $SUPABASE_SERVICE_ROLE_KEY + x-worka-builder-id.
//
// Model under test (see lib/invoices.ts / migration 099): `invoices` is the
// canonical invoice entity; invoiced = sum(sent/overdue/paid), paid =
// sum(paid), outstanding = invoiced - paid.
//
// Payment model note: v1 is binary (unpaid/paid), no partial payments — the
// milestone brief's worked example ("$30,000 invoice, $20,000 paid") is
// reproduced here as TWO invoices ($20,000 marked paid + $10,000 marked
// sent) so the final numbers (invoiced 30000, paid 20000, outstanding
// 10000) match the brief exactly while staying inside the v1 schema.
//
// Cleanup: deletes both disposable jobs (cascades quotes/quote_line_items/
// invoices/variations) in a `finally` block regardless of outcome.
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
// (...f9, ...fc, ...fd, ...fe, ...ff already taken).
const BUILDER_ID = '00000000-0000-0000-0000-0000000000f8'
const OTHER_BUILDER_ID = '00000000-0000-0000-0000-0000000000f7'
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

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}
function isoDaysAhead(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
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
      supabase.from('builders').upsert({ id: BUILDER_ID, email: 'invoicing-e2e-check@getworka.com', name: 'Invoicing E2E Check' }, { onConflict: 'id', ignoreDuplicates: true }),
      supabase.from('builders').upsert({ id: OTHER_BUILDER_ID, email: 'invoicing-e2e-other-builder@getworka.com', name: 'Invoicing E2E Other Builder' }, { onConflict: 'id', ignoreDuplicates: true }),
    ])

    const { error: jobErr } = await supabase.from('jobs').insert({
      id: jobId, builder_id: BUILDER_ID,
      address: `INVOICING E2E CHECK — 21 Test Ave, Kew VIC (${runTag}), safe to delete`,
      status: 'active', job_type: 'health_check',
    })
    if (jobErr) throw new Error(`job insert failed: ${jobErr.message}`)

    const { error: otherJobErr } = await supabase.from('jobs').insert({
      id: otherJobId, builder_id: OTHER_BUILDER_ID,
      address: `INVOICING E2E CHECK (other builder) — 22 Test Ave, Kew VIC (${runTag}), safe to delete`,
      status: 'active', job_type: 'health_check',
    })
    if (otherJobErr) throw new Error(`other job insert failed: ${otherJobErr.message}`)

    // Contract value: one line item, total 100000, margin_pct 0 -> exactly
    // 100000 via calculateClientPrice — deliberately simple numbers so every
    // expected value below is exact, not approximate.
    const { data: quoteRow, error: quoteErr } = await supabase
      .from('quotes')
      .insert({ job_id: jobId, builder_id: BUILDER_ID, status: 'approved', total_cost: 100000, margin_pct: 0, version: 1 })
      .select('id').single()
    if (quoteErr || !quoteRow) throw new Error(`quote insert failed: ${quoteErr?.message}`)
    const quoteId = quoteRow.id

    const { error: liErr } = await supabase.from('quote_line_items').insert({
      quote_id: quoteId, trade_category_id: 2, description: 'Framing — E2E baseline',
      quantity: 1, unit: 'item', rate: 100000, total: 100000, margin_pct: 0, confidence: 100, is_assumption: false,
    })
    if (liErr) throw new Error(`baseline line item insert failed: ${liErr.message}`)

    // Actual cost logged (Financials v1) — independent of invoicing, must
    // stay untouched by every invoice operation below.
    const { error: costErr } = await supabase.from('job_cost_entries').insert({
      job_id: jobId, builder_id: BUILDER_ID, description: 'Framing labour + materials', amount: 40000, incurred_on: isoDaysAgo(5),
    })
    if (costErr) throw new Error(`cost entry insert failed: ${costErr.message}`)

    const baselineContractValue = 100000
    log('setup_complete', { job_id: jobId, quote_id: quoteId, baseline_contract_value: baselineContractValue })

    // ── 1. Baseline snapshot — no invoices yet ───────────────────────────
    const snap0 = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    const ov0 = snap0.json?.snapshot?.overview
    check('baseline_snapshot_correct', ov0?.contract_value === 100000 && ov0?.actual_cost === 40000 && ov0?.current_margin === 60000 && ov0?.invoiced === 0 && ov0?.paid === 0 && ov0?.outstanding === 0, { overview: ov0 })

    // ── 2. Invoice creation — two invoices ───────────────────────────────
    const createA = await apiFetch(`/api/jobs/${jobId}/invoices`, { method: 'POST', body: JSON.stringify({ description: 'Deposit', amount: 20000 }) })
    check('create_invoice_a_ok', createA.ok && createA.json?.invoice?.status === 'draft' && createA.json?.invoice?.amount === 20000, { status: createA.status, body: createA.json ?? createA.text })
    const invoiceAId = createA.json?.invoice?.id

    const createB = await apiFetch(`/api/jobs/${jobId}/invoices`, { method: 'POST', body: JSON.stringify({ description: 'Frame stage', amount: 10000, due_date: isoDaysAgo(3) }) })
    check('create_invoice_b_ok', createB.ok && createB.json?.invoice?.amount === 10000, { status: createB.status, body: createB.json ?? createB.text })
    const invoiceBId = createB.json?.invoice?.id

    check('invoice_number_generated', !!createA.json?.invoice?.invoice_number && !!createB.json?.invoice?.invoice_number && createA.json.invoice.invoice_number !== createB.json.invoice.invoice_number, {
      a: createA.json?.invoice?.invoice_number, b: createB.json?.invoice?.invoice_number,
    })

    // ── 3. Draft behaviour — drafts don't move any of the three totals ───
    const listAfterDrafts = await apiFetch(`/api/jobs/${jobId}/invoices`)
    check('drafts_excluded_from_invoiced', listAfterDrafts.json?.invoiced === 0 && listAfterDrafts.json?.paid === 0 && listAfterDrafts.json?.outstanding === 0, {
      invoiced: listAfterDrafts.json?.invoiced, paid: listAfterDrafts.json?.paid, outstanding: listAfterDrafts.json?.outstanding,
    })

    // ── 4. Sent behaviour ──────────────────────────────────────────────
    const sendA = await apiFetch(`/api/jobs/${jobId}/invoices/${invoiceAId}`, { method: 'PATCH', body: JSON.stringify({ action: 'send' }) })
    check('mark_sent_a_ok', sendA.ok && sendA.json?.invoice?.status === 'sent' && !!sendA.json?.invoice?.sent_at, { status: sendA.status, body: sendA.json ?? sendA.text })

    const listAfterSendA = await apiFetch(`/api/jobs/${jobId}/invoices`)
    check('invoiced_equals_sent_amount', listAfterSendA.json?.invoiced === 20000 && listAfterSendA.json?.outstanding === 20000 && listAfterSendA.json?.paid === 0, {
      invoiced: listAfterSendA.json?.invoiced, outstanding: listAfterSendA.json?.outstanding,
    })

    // ── 5. Paid behaviour ──────────────────────────────────────────────
    const payA = await apiFetch(`/api/jobs/${jobId}/invoices/${invoiceAId}`, { method: 'PATCH', body: JSON.stringify({ action: 'mark_paid' }) })
    check('mark_paid_a_ok', payA.ok && payA.json?.invoice?.status === 'paid' && !!payA.json?.invoice?.paid_at, { status: payA.status, body: payA.json ?? payA.text })

    const listAfterPayA = await apiFetch(`/api/jobs/${jobId}/invoices`)
    check('paid_equals_paid_amount', listAfterPayA.json?.paid === 20000 && listAfterPayA.json?.outstanding === 0 && listAfterPayA.json?.invoiced === 20000, {
      paid: listAfterPayA.json?.paid, outstanding: listAfterPayA.json?.outstanding,
    })

    // ── 6. mark_unpaid — the one supported reversal ──────────────────────
    const unpayA = await apiFetch(`/api/jobs/${jobId}/invoices/${invoiceAId}`, { method: 'PATCH', body: JSON.stringify({ action: 'mark_unpaid' }) })
    check('mark_unpaid_a_ok', unpayA.ok && unpayA.json?.invoice?.status === 'sent' && unpayA.json?.invoice?.paid_at === null, { status: unpayA.status, body: unpayA.json ?? unpayA.text })
    const listAfterUnpayA = await apiFetch(`/api/jobs/${jobId}/invoices`)
    check('unpaid_reversal_updates_totals', listAfterUnpayA.json?.paid === 0 && listAfterUnpayA.json?.outstanding === 20000 && listAfterUnpayA.json?.invoiced === 20000, {
      paid: listAfterUnpayA.json?.paid, outstanding: listAfterUnpayA.json?.outstanding,
    })
    // Restore A to paid so the rest of the scenario matches the milestone's worked example.
    const repayA = await apiFetch(`/api/jobs/${jobId}/invoices/${invoiceAId}`, { method: 'PATCH', body: JSON.stringify({ action: 'mark_paid' }) })
    check('repay_a_ok', repayA.ok && repayA.json?.invoice?.status === 'paid', { status: repayA.status })

    // ── 7. Multiple invoices + overdue ───────────────────────────────────
    const sendB = await apiFetch(`/api/jobs/${jobId}/invoices/${invoiceBId}`, { method: 'PATCH', body: JSON.stringify({ action: 'send' }) })
    // B's due_date is already in the past (isoDaysAgo(3) above) — marking it
    // sent now correctly derives straight to 'overdue' (status is derived at
    // read/response time, never a separate stored transition), not 'sent'.
    check('mark_sent_b_ok', sendB.ok && (sendB.json?.invoice?.status === 'sent' || sendB.json?.invoice?.status === 'overdue'), { status: sendB.status, invoiceStatus: sendB.json?.invoice?.status })

    const listAfterSendB = await apiFetch(`/api/jobs/${jobId}/invoices`)
    check('multiple_invoices_totals_correct', listAfterSendB.json?.invoiced === 30000 && listAfterSendB.json?.paid === 20000 && listAfterSendB.json?.outstanding === 10000, {
      invoiced: listAfterSendB.json?.invoiced, paid: listAfterSendB.json?.paid, outstanding: listAfterSendB.json?.outstanding,
    })
    const bRow = (listAfterSendB.json?.invoices ?? []).find((i) => i.id === invoiceBId)
    check('overdue_derived_correctly_for_b', bRow?.status === 'overdue', { row: bRow })

    // ── 8. Status safety — invalid transitions rejected ───────────────────
    const createC = await apiFetch(`/api/jobs/${jobId}/invoices`, { method: 'POST', body: JSON.stringify({ description: 'Test draft', amount: 500 }) })
    const invoiceCId = createC.json?.invoice?.id
    check('create_invoice_c_ok', createC.ok && !!invoiceCId, { status: createC.status })

    const invalidDraftToPaid = await apiFetch(`/api/jobs/${jobId}/invoices/${invoiceCId}`, { method: 'PATCH', body: JSON.stringify({ action: 'mark_paid' }) })
    check('draft_to_paid_rejected', !invalidDraftToPaid.ok && invalidDraftToPaid.status === 422, { status: invalidDraftToPaid.status, body: invalidDraftToPaid.json })

    const invalidEditSent = await apiFetch(`/api/jobs/${jobId}/invoices/${invoiceBId}`, { method: 'PATCH', body: JSON.stringify({ action: 'edit', amount: 99999 }) })
    check('edit_on_sent_invoice_rejected', !invalidEditSent.ok && invalidEditSent.status === 422, { status: invalidEditSent.status, body: invalidEditSent.json })

    const { data: bRowAfterInvalidEdit } = await supabase.from('invoices').select('amount').eq('id', invoiceBId).single()
    check('sent_invoice_amount_unchanged_after_rejected_edit', bRowAfterInvalidEdit?.amount === 10000, { row: bRowAfterInvalidEdit })

    const deleteC = await apiFetch(`/api/jobs/${jobId}/invoices/${invoiceCId}`, { method: 'DELETE' })
    check('delete_draft_c_ok', deleteC.ok && deleteC.json?.deleted === true, { status: deleteC.status, body: deleteC.json })

    const listAfterDeleteC = await apiFetch(`/api/jobs/${jobId}/invoices`)
    check('deleted_draft_not_in_list', !(listAfterDeleteC.json?.invoices ?? []).some((i) => i.id === invoiceCId), { count: listAfterDeleteC.json?.invoices?.length })

    // ── 9. Variation interaction ─────────────────────────────────────────
    const raiseVar = await apiFetch('/api/variations', { method: 'POST', body: JSON.stringify({ job_id: jobId, title: 'Extra power points', description: 'Client requested additional GPOs', amount: 10000, trade_category_id: 1 }) })
    check('raise_variation_ok', raiseVar.ok && !!raiseVar.json?.variation?.id, { status: raiseVar.status, body: raiseVar.json ?? raiseVar.text })
    const variationId = raiseVar.json?.variation?.id

    const approveVar = await apiFetch(`/api/variations/${variationId}/resolve`, { method: 'POST', body: JSON.stringify({ action: 'approved' }) })
    check('approve_variation_ok', approveVar.ok && approveVar.json?.contract_effect?.applied === true, { status: approveVar.status, contract_effect: approveVar.json?.contract_effect })

    const expectedContractValueAfterVariation = round2(baselineContractValue + 10000) // 110000
    const listAfterVariation = await apiFetch(`/api/jobs/${jobId}/invoices`)
    check('contract_value_reflects_variation', listAfterVariation.json?.contract_value === expectedContractValueAfterVariation, { expected: expectedContractValueAfterVariation, actual: listAfterVariation.json?.contract_value })

    const { data: invoicesAfterVariation } = await supabase.from('invoices').select('id, amount').in('id', [invoiceAId, invoiceBId])
    const aStillCorrect = invoicesAfterVariation?.find((i) => i.id === invoiceAId)?.amount === 20000
    const bStillCorrect = invoicesAfterVariation?.find((i) => i.id === invoiceBId)?.amount === 10000
    check('historical_invoices_unchanged_by_variation', aStillCorrect && bStillCorrect, { rows: invoicesAfterVariation })

    // Creating an invoice that would push total invoiced above the new
    // contract value (30000 existing + 90000 > 110000) must be rejected.
    const overshoot = await apiFetch(`/api/jobs/${jobId}/invoices`, { method: 'POST', body: JSON.stringify({ description: 'Too much', amount: 90000 }) })
    check('invoice_exceeding_contract_value_rejected', !overshoot.ok && overshoot.status === 422, { status: overshoot.status, body: overshoot.json })

    // ── 10. Security — cross-builder isolation ───────────────────────────
    const otherCreate = await otherFetch(`/api/jobs/${otherJobId}/invoices`, { method: 'POST', body: JSON.stringify({ description: 'Other builder invoice', amount: 500 }) })
    check('other_builder_can_create_own_invoice', otherCreate.ok && !!otherCreate.json?.invoice?.id, { status: otherCreate.status })
    const otherInvoiceId = otherCreate.json?.invoice?.id

    const crossReadAttempt = await apiFetch(`/api/jobs/${otherJobId}/invoices`)
    check('cross_builder_list_blocked', !crossReadAttempt.ok && crossReadAttempt.status === 404, { status: crossReadAttempt.status })

    const crossPatchAttempt = await apiFetch(`/api/jobs/${otherJobId}/invoices/${otherInvoiceId}`, { method: 'PATCH', body: JSON.stringify({ action: 'send' }) })
    check('cross_builder_mark_sent_blocked', !crossPatchAttempt.ok && crossPatchAttempt.status === 404, { status: crossPatchAttempt.status })

    const crossDeleteAttempt = await apiFetch(`/api/jobs/${otherJobId}/invoices/${otherInvoiceId}`, { method: 'DELETE' })
    check('cross_builder_delete_blocked', !crossDeleteAttempt.ok && crossDeleteAttempt.status === 404, { status: crossDeleteAttempt.status })

    const { data: otherInvoiceRow } = await supabase.from('invoices').select('status, amount').eq('id', otherInvoiceId).single()
    check('other_builder_invoice_untouched', otherInvoiceRow?.status === 'draft' && otherInvoiceRow?.amount === 500, { row: otherInvoiceRow })

    // Cross-job: this builder's own job id combined with the other job's invoice id.
    const crossJobAttempt = await apiFetch(`/api/jobs/${jobId}/invoices/${otherInvoiceId}`, { method: 'PATCH', body: JSON.stringify({ action: 'send' }) })
    check('cross_job_invoice_id_blocked', !crossJobAttempt.ok && crossJobAttempt.status === 404, { status: crossJobAttempt.status })

    // ── 11. Snapshot integration — authoritative figures, independently expected ──
    const finalSnap = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    const finalOv = finalSnap.json?.snapshot?.overview
    check('snapshot_contract_value_correct', finalOv?.contract_value === 110000, { expected: 110000, actual: finalOv?.contract_value })
    check('snapshot_actual_cost_correct', finalOv?.actual_cost === 40000, { expected: 40000, actual: finalOv?.actual_cost })
    check('snapshot_current_margin_correct', finalOv?.current_margin === 70000, { expected: 70000, actual: finalOv?.current_margin })
    check('snapshot_invoiced_correct', finalOv?.invoiced === 30000, { expected: 30000, actual: finalOv?.invoiced })
    check('snapshot_paid_correct', finalOv?.paid === 20000, { expected: 20000, actual: finalOv?.paid })
    check('snapshot_outstanding_correct', finalOv?.outstanding === 10000, { expected: 10000, actual: finalOv?.outstanding })

    // ── 12. Persistence ────────────────────────────────────────────────
    await new Promise((r) => setTimeout(r, 2000))
    const freshSnap = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    const freshOv = freshSnap.json?.snapshot?.overview
    check('persists_across_fresh_snapshot_request', freshOv?.invoiced === 30000 && freshOv?.paid === 20000 && freshOv?.outstanding === 10000 && freshOv?.contract_value === 110000, { overview: freshOv })

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
      await supabase.from('jobs').delete().eq('id', jobId) // cascades quotes/quote_line_items/invoices/variations/job_cost_entries
      await supabase.from('jobs').delete().eq('id', otherJobId)
      log('cleanup_complete', { job_id: jobId, other_job_id: otherJobId })
    } catch (cleanupErr) {
      log('cleanup_failed', { error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) })
    }
  }

  process.exit(result.passed ? 0 : 1)
}

main()
