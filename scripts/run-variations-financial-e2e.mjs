#!/usr/bin/env node
// ============================================================
// WorkA — live end-to-end verification of Variations v1 — Connect Contract
// & Margin, driven through the ACTUAL deployed app routes (not direct DB
// writes for anything under test).
// ============================================================
// Same authenticated real-route pattern as run-manual-estimate-e2e.mjs and
// run-job-costs-e2e.mjs: real fetch() calls to APP_URL, authenticated via
// the documented internal server-to-server path (lib/auth/api-auth.ts) —
// Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY + x-worka-builder-id.
//
// Covers:
//   1. Raise a variation (real POST) — confirm it does NOT affect contract
//      value while draft/pending.
//   2. Builder-side approval (POST .../resolve) — confirm it becomes
//      exactly one quote_line_items row and contract value/margin update
//      correctly, verified independently (not just trusting the API echo).
//   3. Repeat the exact same approval request — confirm idempotency: still
//      exactly one line item, contract value unchanged by the retry.
//   4. A second variation, approved via the CLIENT PORTAL path (PATCH with
//      a real share token) — confirm it converges on the identical
//      mechanism and financial result as the builder-side path.
//   5. A third variation, REJECTED — confirm zero financial effect: no
//      line item, contract value/margin unchanged.
//   6. Existing manual line items on the same quote are confirmed intact
//      throughout — a variation must never touch/duplicate them.
//   7. Fresh, independent GET/snapshot calls confirm persistence.
//
// This script does NOT touch the AI estimation pipeline — the quote used
// here is created directly with real quote_line_items, exactly like
// run-job-costs-e2e.mjs's setup. Variations v1 has no AI-pipeline
// dependency.
//
// Cleanup: deletes the disposable job (cascades quotes/quote_line_items/
// variations) in a `finally` block regardless of outcome.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { createHash, randomBytes } from 'node:crypto'
import crypto from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL must all be set' }))
  process.exit(1)
}

// Reserved, distinct from every other script's builder id in this repo
// (...fc, ...fd, ...fe, ...ff already taken).
const BUILDER_ID = '00000000-0000-0000-0000-0000000000f9'
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

// Client portal calls (PATCH .../[variationId]) are NOT authenticated via
// the builder headers — they're public, gated only by the share token, so
// this deliberately omits AUTH_HEADERS to prove the real client-facing path.
async function publicFetch(path, options = {}) {
  const url = `${APP_URL.replace(/\/$/, '')}${path}`
  const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) } })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, json, text }
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const jobId = crypto.randomUUID()
  const runTag = new Date().toISOString()
  const result = { job_id: jobId, passed: false }

  try {
    log('run_started', { job_id: jobId })

    await supabase.from('builders').upsert(
      { id: BUILDER_ID, email: 'variations-e2e-check@getworka.com', name: 'Variations E2E Check' },
      { onConflict: 'id', ignoreDuplicates: true }
    )

    const { error: jobErr } = await supabase.from('jobs').insert({
      id: jobId,
      builder_id: BUILDER_ID,
      address: `VARIATIONS E2E CHECK — 9 Test Ave, Kew VIC (${runTag}), safe to delete`,
      status: 'active',
      job_type: 'health_check',
    })
    if (jobErr) throw new Error(`job insert failed: ${jobErr.message}`)

    const { data: quoteRow, error: quoteErr } = await supabase
      .from('quotes')
      .insert({ job_id: jobId, builder_id: BUILDER_ID, status: 'approved', total_cost: 20000, margin_pct: 0.15, version: 1 })
      .select('id')
      .single()
    if (quoteErr || !quoteRow) throw new Error(`quote insert failed: ${quoteErr?.message ?? 'no row'}`)
    const quoteId = quoteRow.id
    result.quote_id = quoteId

    // One pre-existing manual line item — proves a variation never touches
    // an unrelated existing line. Cost 20000, margin 0.15 -> client price
    // 23000. This is the baseline contract value before any variation.
    const { data: existingLineItem, error: liErr } = await supabase
      .from('quote_line_items')
      .insert({ quote_id: quoteId, trade_category_id: 2, description: 'Framing — E2E baseline', quantity: 1, unit: 'item', rate: 20000, total: 20000, margin_pct: 0.15, confidence: 100, is_assumption: false })
      .select('id')
      .single()
    if (liErr || !existingLineItem) throw new Error(`baseline line item insert failed: ${liErr?.message}`)

    const baselineContractValue = round2(20000 * 1.15) // 23000
    log('setup_complete', { job_id: jobId, quote_id: quoteId, baseline_contract_value: baselineContractValue })

    // ── Step 1: raise a variation, confirm no financial effect while draft ──
    const variation1Amount = 3200
    const raise1 = await apiFetch('/api/variations', {
      method: 'POST',
      body: JSON.stringify({ job_id: jobId, title: 'Upgrade to stone benchtops', description: 'Client requested stone benchtop upgrade', amount: variation1Amount, trade_category_id: 8 }),
    })
    check('raise_variation_1_ok', raise1.ok && !!raise1.json?.variation?.id, { status: raise1.status, body: raise1.json ?? raise1.text })
    const variation1Id = raise1.json?.variation?.id

    const snapshotAfterRaise = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    check('draft_variation_does_not_affect_contract_value', snapshotAfterRaise.json?.snapshot?.overview?.contract_value === baselineContractValue, {
      expected: baselineContractValue, actual: snapshotAfterRaise.json?.snapshot?.overview?.contract_value,
    })

    // ── Step 2: builder-side approval ────────────────────────────────────
    const approve1 = await apiFetch(`/api/variations/${variation1Id}/resolve`, { method: 'POST', body: JSON.stringify({ action: 'approved' }) })
    check('builder_approval_ok', approve1.ok && approve1.json?.variation?.status === 'approved', { status: approve1.status, body: approve1.json ?? approve1.text })
    check('builder_approval_applied_to_quote', approve1.json?.contract_effect?.applied === true && approve1.json?.contract_effect?.alreadyApplied === false, { contract_effect: approve1.json?.contract_effect })

    const { data: lineItemsAfterApprove1 } = await supabase.from('quote_line_items').select('id, variation_id, description, total, pricing_source, predicted_by').eq('variation_id', variation1Id)
    check('exactly_one_line_item_for_variation_1', (lineItemsAfterApprove1 ?? []).length === 1, { rows: lineItemsAfterApprove1 })
    check('line_item_provenance_correct', lineItemsAfterApprove1?.[0]?.pricing_source === 'variation' && lineItemsAfterApprove1?.[0]?.predicted_by === 'human' && lineItemsAfterApprove1?.[0]?.total === variation1Amount, { row: lineItemsAfterApprove1?.[0] })

    const expectedContractValueAfterV1 = round2(baselineContractValue + variation1Amount) // 26200 (margin_pct 0 on the variation line -> passes straight through)
    const snapshot1 = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    const overview1 = snapshot1.json?.snapshot?.overview
    check('contract_value_increased_by_exactly_the_variation_amount', overview1?.contract_value === expectedContractValueAfterV1, { expected: expectedContractValueAfterV1, actual: overview1?.contract_value })
    check('current_margin_updated_correctly_after_v1', overview1?.current_margin === round2(expectedContractValueAfterV1 - 0), { expected: round2(expectedContractValueAfterV1 - 0), actual: overview1?.current_margin })

    // ── Step 3: idempotency — repeat the exact same approval request ────
    const approve1Again = await apiFetch(`/api/variations/${variation1Id}/resolve`, { method: 'POST', body: JSON.stringify({ action: 'approved' }) })
    check('repeat_approval_rejected_by_forward_only_gate', !approve1Again.ok && approve1Again.status === 422, { status: approve1Again.status, body: approve1Again.json ?? approve1Again.text })

    const { data: lineItemsAfterRetry } = await supabase.from('quote_line_items').select('id').eq('variation_id', variation1Id)
    check('idempotent_still_exactly_one_line_item', (lineItemsAfterRetry ?? []).length === 1, { count: lineItemsAfterRetry?.length })

    const snapshotAfterRetry = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    check('idempotent_contract_value_unchanged_by_retry', snapshotAfterRetry.json?.snapshot?.overview?.contract_value === expectedContractValueAfterV1, { expected: expectedContractValueAfterV1, actual: snapshotAfterRetry.json?.snapshot?.overview?.contract_value })

    // ── Step 4: client-portal approval path ──────────────────────────────
    const variation2Amount = 1800
    const raise2 = await apiFetch('/api/variations', {
      method: 'POST',
      body: JSON.stringify({ job_id: jobId, title: 'Additional external tap', description: 'Extra outdoor tap requested', amount: variation2Amount, trade_category_id: 1 }),
    })
    check('raise_variation_2_ok', raise2.ok && !!raise2.json?.variation?.id, { status: raise2.status, body: raise2.json ?? raise2.text })
    const variation2Id = raise2.json?.variation?.id

    // Mint a real share token the same way POST .../share does (sha256 hash
    // stored, raw token given to the "client") — done directly here rather
    // than via the share endpoint's email-adjacent side effects, since only
    // the token mechanism itself is under test in this step.
    const rawToken = randomBytes(24).toString('hex')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const { error: tokenErr } = await supabase
      .from('variations')
      .update({ share_token_hash: tokenHash, share_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() })
      .eq('id', variation2Id)
    if (tokenErr) throw new Error(`share token setup failed: ${tokenErr.message}`)

    const approve2 = await publicFetch(`/api/variations/${variation2Id}?t=${rawToken}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved', approved_by: 'Test Client', t: rawToken }),
    })
    check('client_portal_approval_ok', approve2.ok && approve2.json?.variation?.status === 'approved', { status: approve2.status, body: approve2.json ?? approve2.text })
    check('client_portal_approval_applied_to_quote', approve2.json?.contract_effect?.applied === true, { contract_effect: approve2.json?.contract_effect })

    const { data: lineItemsForV2 } = await supabase.from('quote_line_items').select('id, total, pricing_source').eq('variation_id', variation2Id)
    check('exactly_one_line_item_for_variation_2', (lineItemsForV2 ?? []).length === 1 && lineItemsForV2?.[0]?.total === variation2Amount, { rows: lineItemsForV2 })

    const expectedContractValueAfterV2 = round2(expectedContractValueAfterV1 + variation2Amount) // 28000
    const snapshot2 = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    check('client_portal_path_produces_same_financial_result', snapshot2.json?.snapshot?.overview?.contract_value === expectedContractValueAfterV2, { expected: expectedContractValueAfterV2, actual: snapshot2.json?.snapshot?.overview?.contract_value })

    // ── Step 5: rejection has zero financial effect ──────────────────────
    const variation3Amount = 5000
    const raise3 = await apiFetch('/api/variations', {
      method: 'POST',
      body: JSON.stringify({ job_id: jobId, title: 'Premium fixtures upgrade (declined)', description: 'Client considered but did not proceed', amount: variation3Amount, trade_category_id: 11 }),
    })
    const variation3Id = raise3.json?.variation?.id
    check('raise_variation_3_ok', raise3.ok && !!variation3Id, { status: raise3.status })

    const reject3 = await apiFetch(`/api/variations/${variation3Id}/resolve`, { method: 'POST', body: JSON.stringify({ action: 'rejected' }) })
    check('rejection_ok', reject3.ok && reject3.json?.variation?.status === 'rejected', { status: reject3.status, body: reject3.json ?? reject3.text })
    check('rejection_has_no_contract_effect_field', reject3.json?.contract_effect === null, { contract_effect: reject3.json?.contract_effect })

    const { data: lineItemsForV3 } = await supabase.from('quote_line_items').select('id').eq('variation_id', variation3Id)
    check('rejected_variation_creates_no_line_item', (lineItemsForV3 ?? []).length === 0, { count: lineItemsForV3?.length })

    const snapshotAfterReject = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    check('contract_value_unchanged_after_rejection', snapshotAfterReject.json?.snapshot?.overview?.contract_value === expectedContractValueAfterV2, { expected: expectedContractValueAfterV2, actual: snapshotAfterReject.json?.snapshot?.overview?.contract_value })

    // ── Step 6: the original manual line item is untouched throughout ───
    const { data: baselineRowNow } = await supabase.from('quote_line_items').select('id, total, description').eq('id', existingLineItem.id).single()
    check('existing_manual_line_item_untouched', baselineRowNow?.total === 20000 && baselineRowNow?.description === 'Framing — E2E baseline', { row: baselineRowNow })

    const { data: allLineItemsFinal } = await supabase.from('quote_line_items').select('id').eq('quote_id', quoteId)
    check('exactly_three_line_items_total_baseline_plus_two_approved_variations', (allLineItemsFinal ?? []).length === 3, { count: allLineItemsFinal?.length })

    // ── Step 7: persistence — independent, later requests ────────────────
    await new Promise((r) => setTimeout(r, 2000))
    const finalSnapshot = await apiFetch(`/api/jobs/${jobId}/snapshot`)
    const finalOverview = finalSnapshot.json?.snapshot?.overview
    check('persists_across_fresh_snapshot_request', finalOverview?.contract_value === expectedContractValueAfterV2, { expected: expectedContractValueAfterV2, actual: finalOverview?.contract_value })
    const expectedFinalMargin = round2(expectedContractValueAfterV2 - 0)
    check('final_margin_correct', finalOverview?.current_margin === expectedFinalMargin, { expected: expectedFinalMargin, actual: finalOverview?.current_margin })
    const expectedFinalMarginPct = Math.round((expectedFinalMargin / expectedContractValueAfterV2) * 100)
    check('final_margin_pct_correct', finalOverview?.current_margin_pct === expectedFinalMarginPct, { expected: expectedFinalMarginPct, actual: finalOverview?.current_margin_pct })

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
      await supabase.from('jobs').delete().eq('id', jobId) // cascades quotes/quote_line_items/variations
      log('cleanup_complete', { job_id: jobId })
    } catch (cleanupErr) {
      log('cleanup_failed', { error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) })
    }
  }

  process.exit(result.passed ? 0 : 1)
}

main()
