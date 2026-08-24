#!/usr/bin/env node
// ============================================================
// WorkA — PostgREST RPC vs direct-SQL behavioral test (self-contained)
// ============================================================
// Creates its own disposable synthetic estimate_runs/document_processing_
// batches row pair (cloned from the most recent real terminal batch,
// explicitly forced extension-eligible: quote_id null, stage3/stage6
// failure counts 0), then calls enforce_estimate_deadlines() and
// find_stuck_batches_needing_classification_retry() through the EXACT
// same mechanism app/api/cron/intake-recovery/route.ts uses
// (@supabase/supabase-js's .rpc(), service-role key) — the PostgREST
// path — and reports whether the synthetic row was selected/modified.
// Self-contained (create -> test -> cleanup) specifically so it never
// races a separately-created row against production's own pg_cron, which
// ticks every 60s and would otherwise resolve the row before this script
// gets to it.
//
// Read-only against everything except its own disposable rows; makes
// zero Anthropic calls (neither function ever does).

import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY must be set' }))
  process.exit(1)
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

async function main() {
  // Identical client construction to app/api/cron/intake-recovery/route.ts.
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // ── Financial-safety BEFORE snapshot ──────────────────────────────────
  const { count: opsBefore } = await supabase.from('ai_operations').select('*', { count: 'exact', head: true })
  log('financial_safety_before', { ops_before: opsBefore })

  // ── Find the most recent real terminal batch that HAS an estimate_runs row ──
  // (queried from the estimate_runs side with an inner join, so a terminal
  // batch that happens to have no run -- e.g. legacy pre-Option-D data --
  // is never selected as the clone source)
  const { data: sourceRuns, error: sourceErr } = await supabase
    .from('estimate_runs')
    .select('*, document_processing_batches!inner(*)')
    .in('document_processing_batches.status', ['completed', 'completed_with_failures', 'failed'])
    .order('started_at', { ascending: false })
    .limit(1)
  if (sourceErr || !sourceRuns?.[0]) {
    log('fatal', { message: 'no source batch+run pair found', error: sourceErr?.message })
    process.exit(1)
  }
  const sourceRun = sourceRuns[0]
  const sourceBatch = sourceRun.document_processing_batches
  if (!sourceBatch) {
    log('fatal', { message: 'source run has no embedded batch' })
    process.exit(1)
  }

  // ── Create the disposable synthetic batch, explicitly extension-eligible ──
  const newBatchId = crypto.randomUUID()
  const batchClone = { ...sourceBatch }
  batchClone.id = newBatchId
  batchClone.created_at = new Date().toISOString()
  batchClone.updated_at = new Date(Date.now() - 5 * 60_000).toISOString()
  batchClone.quote_id = null
  batchClone.stage3_failure_count = 0
  batchClone.stage6_failure_count = 0
  batchClone.status = 'completed'
  batchClone.classification_triggered = true

  const { error: batchInsertErr } = await supabase.from('document_processing_batches').insert(batchClone)
  if (batchInsertErr) {
    log('fatal', { message: 'batch insert failed', error: batchInsertErr.message })
    process.exit(1)
  }

  const newRunId = crypto.randomUUID()
  const runClone = { ...sourceRun }
  delete runClone.document_processing_batches
  runClone.id = newRunId
  runClone.batch_id = newBatchId
  runClone.builder_status = null
  runClone.needs_review_reason = null
  runClone.needs_review_reason_code = null
  runClone.deadline_extensions_used = 0
  runClone.deadline_at = new Date(Date.now() - 60_000).toISOString() // already overdue
  runClone.started_at = new Date(Date.now() - 16 * 60_000).toISOString()
  runClone.completed_at = null
  runClone.reconciled_at = new Date().toISOString()
  runClone.watchdog_first_eligible_at = null
  runClone.watchdog_last_eligible_at = null
  runClone.watchdog_last_attempt_at = null
  runClone.watchdog_consecutive_misses = 0
  runClone.watchdog_total_misses = 0
  runClone.watchdog_escalated_at = null
  runClone.watchdog_escalation_reason = null

  const { error: runInsertErr } = await supabase.from('estimate_runs').insert(runClone)
  if (runInsertErr) {
    log('fatal', { message: 'estimate_run insert failed', error: runInsertErr.message })
    process.exit(1)
  }

  log('synthetic_row_created', { batch_id: newBatchId, estimate_run_id: newRunId, job_id: runClone.job_id })

  // ── Confirm eligibility, read via PostgREST (same path the test itself uses) ──
  const { data: beforeRow } = await supabase
    .from('estimate_runs')
    .select('id, deadline_at, deadline_extensions_used, builder_status, watchdog_consecutive_misses, watchdog_total_misses')
    .eq('id', newRunId)
    .single()
  log('before_state', { row: beforeRow })

  // ── Call 1: enforce_estimate_deadlines() — exactly as route.ts calls it ──
  const { data: enforceData, error: enforceErr, status: enforceStatus } = await supabase.rpc('enforce_estimate_deadlines')
  const enforceRowMatch = Array.isArray(enforceData) ? enforceData.find((r) => r.estimate_run_id === newRunId) : null
  log('rpc_call_enforce_estimate_deadlines', {
    http_status: enforceStatus,
    error: enforceErr?.message ?? null,
    total_rows_returned: Array.isArray(enforceData) ? enforceData.length : null,
    row_present_in_result: Boolean(enforceRowMatch),
    row_result_row: enforceRowMatch ?? null,
  })

  // ── Call 2: find_stuck_batches_needing_classification_retry() ──
  const { data: stuckData, error: stuckErr, status: stuckStatus } = await supabase.rpc('find_stuck_batches_needing_classification_retry')
  const stuckRowMatch = Array.isArray(stuckData) ? stuckData.find((r) => r.batch_id === newBatchId) : null
  log('rpc_call_find_stuck_batches_needing_classification_retry', {
    http_status: stuckStatus,
    error: stuckErr?.message ?? null,
    total_rows_returned: Array.isArray(stuckData) ? stuckData.length : null,
    row_batch_present_in_result: Boolean(stuckRowMatch),
    row_result_row: stuckRowMatch ?? null,
  })

  // ── AFTER state ──────────────────────────────────────────────────────
  const { data: afterRow } = await supabase
    .from('estimate_runs')
    .select('id, deadline_at, deadline_extensions_used, builder_status, completed_at, needs_review_reason, watchdog_consecutive_misses, watchdog_total_misses')
    .eq('id', newRunId)
    .single()
  log('after_state', { row: afterRow })

  const rowWasModified = beforeRow && afterRow && (
    beforeRow.deadline_at !== afterRow.deadline_at ||
    beforeRow.deadline_extensions_used !== afterRow.deadline_extensions_used ||
    beforeRow.builder_status !== afterRow.builder_status
  )

  // ── Financial-safety AFTER snapshot ───────────────────────────────────
  const { count: opsAfter } = await supabase.from('ai_operations').select('*', { count: 'exact', head: true })

  log('test_complete', {
    row_was_modified: rowWasModified,
    ops_before: opsBefore,
    ops_after: opsAfter,
    zero_ai_spend: opsBefore === opsAfter,
  })

  // ── Cleanup ──────────────────────────────────────────────────────────
  const { error: cleanupErr } = await supabase.from('document_processing_batches').delete().eq('id', newBatchId)
  log('cleanup', { deleted_batch_id: newBatchId, error: cleanupErr?.message ?? null })
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'test_failed', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
