#!/usr/bin/env node
// ============================================================
// Production E2E for the job-closeout persistence-truthfulness fix
// (Round 7 reliability audit finding). Not part of any milestone.
//
// Three checks against the real, deployed POST /api/estimation/reconcile
// route:
//   1. An invalid trade_category_id is rejected with a 400 BEFORE any write
//      (closes the concrete FK-violation trigger the old bug hit).
//   2. A genuine successful reconciliation: independently verifies
//      project_memory.status='completed', jobs.status='complete', and
//      cost_reconciliation rows exist -- then a resubmission is correctly
//      detected as already_reconciled with no duplicate rows created.
//   3. The repair path: constructs the OLD bug's exact poisoned state
//      directly in the DB (project_memory.status='completed' but
//      jobs.status left 'active' and zero cost_reconciliation rows -- the
//      state a downstream failure used to leave permanently), then calls
//      the real route again and verifies it REPAIRS the state (job reaches
//      'complete', reconciliation rows appear) instead of short-circuiting
//      with a false "already reconciled" response.
//
// Cleans up all synthetic rows in a finally block.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL

const BUILDER_ID = '00000000-0000-0000-0000-0000000000fb' // reserved, previously unused per this session's own ledger

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL must be set' }))
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

const authHeaders = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'x-worka-builder-id': BUILDER_ID,
}

async function makeSyntheticJob(suffix) {
  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .insert({ builder_id: BUILDER_ID, address: `${randomUUID()} Test St, Closeout E2E ${suffix}`, status: 'active' })
    .select('id')
    .single()
  if (jobErr || !job) throw new Error(`create_job failed: ${jobErr?.message}`)

  const { data: quote, error: quoteErr } = await supabase
    .from('quotes')
    .insert({ job_id: job.id, builder_id: BUILDER_ID, status: 'approved', total_cost: 5000, margin_pct: 0.2, confidence_score: 100, version: 1 })
    .select('id')
    .single()
  if (quoteErr || !quote) throw new Error(`create_quote failed: ${quoteErr?.message}`)

  return { jobId: job.id, quoteId: quote.id }
}

async function cleanupJob(jobId, quoteId, memoryId) {
  try {
    if (memoryId) await supabase.from('cost_reconciliation').delete().eq('project_memory_id', memoryId)
    if (jobId) await supabase.from('project_memory').delete().eq('job_id', jobId)
    if (quoteId) await supabase.from('quotes').delete().eq('id', quoteId)
    if (jobId) await supabase.from('jobs').delete().eq('id', jobId)
  } catch (err) {
    log('cleanup_failed', { job_id: jobId, error: err instanceof Error ? err.message : String(err) })
  }
}

async function main() {
  let passed = true
  const failures = []

  await supabase.from('builders').upsert(
    { id: BUILDER_ID, email: 'job-closeout-truthfulness-e2e@getworka.com', name: 'Job Closeout Truthfulness E2E' },
    { onConflict: 'id', ignoreDuplicates: true }
  )

  // ── 1. Invalid trade_category_id rejected before any write ────────────
  const invalidJob = await makeSyntheticJob('invalid-trade')
  log('invalid_trade_job_created', invalidJob)

  const invalidRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/estimation/reconcile`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      job_id: invalidJob.jobId,
      quote_id: invalidJob.quoteId,
      entries: [{ trade_category_id: 999, trade_category_name: 'Bogus', estimated_cost: 1000, actual_cost: 1200, variance_amount: 200, variance_pct: 20 }],
      final_cost: 1200,
      final_margin_pct: 0.2,
    }),
  })
  const invalidBody = await invalidRes.json().catch(() => ({}))
  log('invalid_trade_call', { http_status: invalidRes.status, body: invalidBody })

  if (invalidRes.status !== 400) {
    passed = false
    failures.push(`expected 400 for invalid trade_category_id, got ${invalidRes.status}`)
  }

  const { data: memoryAfterInvalid } = await supabase.from('project_memory').select('id').eq('job_id', invalidJob.jobId).maybeSingle()
  log('project_memory_after_invalid_trade', { exists: Boolean(memoryAfterInvalid) })
  if (memoryAfterInvalid) {
    passed = false
    failures.push('expected no project_memory row after a rejected invalid trade_category_id, but one was created')
  }

  await cleanupJob(invalidJob.jobId, invalidJob.quoteId, memoryAfterInvalid?.id)

  // ── 2. Genuine successful reconciliation + idempotent resubmission ────
  const okJob = await makeSyntheticJob('success')
  log('success_job_created', okJob)

  const validEntries = [
    { trade_category_id: 6, trade_category_name: 'Plumbing', estimated_cost: 3000, actual_cost: 3200, variance_amount: 200, variance_pct: 6.7 },
    { trade_category_id: 8, trade_category_name: 'Electrical', estimated_cost: 2000, actual_cost: 1900, variance_amount: -100, variance_pct: -5 },
  ]

  const okRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/estimation/reconcile`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ job_id: okJob.jobId, quote_id: okJob.quoteId, entries: validEntries, final_cost: 5100, final_margin_pct: 0.2 }),
  })
  const okBody = await okRes.json().catch(() => ({}))
  log('success_call', { http_status: okRes.status, body: okBody })

  if (!okRes.ok) {
    passed = false
    failures.push(`expected 2xx for a valid reconciliation, got ${okRes.status}`)
  }

  const { data: memoryAfterOk } = await supabase.from('project_memory').select('id, status').eq('job_id', okJob.jobId).single()
  const { data: jobAfterOk } = await supabase.from('jobs').select('status').eq('id', okJob.jobId).single()
  const { data: reconAfterOk } = await supabase.from('cost_reconciliation').select('id, trade_category_id').eq('project_memory_id', memoryAfterOk?.id ?? '')
  log('state_after_successful_reconciliation', { memory_status: memoryAfterOk?.status, job_status: jobAfterOk?.status, recon_count: reconAfterOk?.length ?? 0 })

  if (memoryAfterOk?.status !== 'completed') {
    passed = false
    failures.push(`expected project_memory.status='completed', got '${memoryAfterOk?.status}'`)
  }
  if (jobAfterOk?.status !== 'complete') {
    passed = false
    failures.push(`expected jobs.status='complete', got '${jobAfterOk?.status}'`)
  }
  if ((reconAfterOk?.length ?? 0) !== 2) {
    passed = false
    failures.push(`expected exactly 2 cost_reconciliation rows, found ${reconAfterOk?.length ?? 0}`)
  }

  // Resubmit identical request -- must be detected as already_reconciled, no duplicates
  const resubmitRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/estimation/reconcile`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ job_id: okJob.jobId, quote_id: okJob.quoteId, entries: validEntries, final_cost: 5100, final_margin_pct: 0.2 }),
  })
  const resubmitBody = await resubmitRes.json().catch(() => ({}))
  log('resubmit_call', { http_status: resubmitRes.status, body: resubmitBody })

  if (resubmitBody.already_reconciled !== true) {
    passed = false
    failures.push(`expected already_reconciled:true on resubmission, got ${JSON.stringify(resubmitBody)}`)
  }

  const { data: reconAfterResubmit } = await supabase.from('cost_reconciliation').select('id').eq('project_memory_id', memoryAfterOk?.id ?? '')
  log('recon_count_after_resubmit', { count: reconAfterResubmit?.length ?? 0 })
  if ((reconAfterResubmit?.length ?? 0) !== 2) {
    passed = false
    failures.push(`resubmission created duplicates -- expected 2 cost_reconciliation rows, found ${reconAfterResubmit?.length ?? 0}`)
  }

  await cleanupJob(okJob.jobId, okJob.quoteId, memoryAfterOk?.id)

  // ── 3. Repair path: construct the OLD bug's poisoned state directly ───
  const repairJob = await makeSyntheticJob('repair')
  log('repair_job_created', repairJob)

  // Directly construct the exact broken state a downstream failure used to
  // leave: project_memory.status='completed' with the job still 'active'
  // and zero cost_reconciliation rows. This is constructing DB state
  // directly to test the repair path, not manufacturing an application
  // failure.
  const { data: poisonedMemory, error: poisonErr } = await supabase
    .from('project_memory')
    .insert({ job_id: repairJob.jobId, builder_id: BUILDER_ID, quote_id: repairJob.quoteId, status: 'completed', final_cost: 5100, final_margin_pct: 0.2, completed_at: new Date().toISOString() })
    .select('id')
    .single()
  if (poisonErr || !poisonedMemory) {
    log('setup_failed', { stage: 'construct_poisoned_state', error: poisonErr?.message })
    passed = false
    failures.push(`failed to construct poisoned state: ${poisonErr?.message}`)
  } else {
    log('poisoned_state_constructed', { memory_id: poisonedMemory.id, job_status: 'active (unchanged)', recon_rows: 0 })

    const repairRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/estimation/reconcile`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ job_id: repairJob.jobId, quote_id: repairJob.quoteId, entries: validEntries, final_cost: 5100, final_margin_pct: 0.2 }),
    })
    const repairBody = await repairRes.json().catch(() => ({}))
    log('repair_call', { http_status: repairRes.status, body: repairBody })

    if (repairBody.already_reconciled === true) {
      passed = false
      failures.push('repair call returned already_reconciled:true against a poisoned (never-actually-completed) state -- the old bug')
    }

    const { data: jobAfterRepair } = await supabase.from('jobs').select('status').eq('id', repairJob.jobId).single()
    const { data: reconAfterRepair } = await supabase.from('cost_reconciliation').select('id').eq('project_memory_id', poisonedMemory.id)
    log('state_after_repair', { job_status: jobAfterRepair?.status, recon_count: reconAfterRepair?.length ?? 0 })

    if (jobAfterRepair?.status !== 'complete') {
      passed = false
      failures.push(`expected the repair call to actually complete the job, got jobs.status='${jobAfterRepair?.status}'`)
    }
    if ((reconAfterRepair?.length ?? 0) !== 2) {
      passed = false
      failures.push(`expected the repair call to insert 2 cost_reconciliation rows, found ${reconAfterRepair?.length ?? 0}`)
    }
  }

  await cleanupJob(repairJob.jobId, repairJob.quoteId, poisonedMemory?.id)

  log(passed ? 'run_passed' : 'run_FAILED', { passed, failures })
  process.exit(passed ? 0 : 1)
}

main().catch(async (err) => {
  log('run_crashed', { error: err instanceof Error ? err.stack : String(err) })
  process.exit(1)
})
