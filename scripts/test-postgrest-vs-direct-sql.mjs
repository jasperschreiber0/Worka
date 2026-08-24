#!/usr/bin/env node
// ============================================================
// WorkA — PostgREST RPC vs direct-SQL behavioral test
// ============================================================
// One-off diagnostic script, not part of the app. Calls
// enforce_estimate_deadlines() and find_stuck_batches_needing_
// classification_retry() through the EXACT same mechanism
// app/api/cron/intake-recovery/route.ts uses (@supabase/supabase-js's
// .rpc(), with the service-role key, same as production) against a
// disposable synthetic row (ROW 2, created by check_postgrest_vs_
// direct_sql_setup.sql), to determine whether the PostgREST RPC path
// produces a different result than a direct SQL connection calling the
// identical functions against ROW 1 already did.
//
// Read-only against everything except this test's own disposable rows;
// makes zero Anthropic calls (neither function ever does).

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ROW2_ESTIMATE_RUN_ID = process.env.ROW2_ESTIMATE_RUN_ID
const ROW2_BATCH_ID = process.env.ROW2_BATCH_ID

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ROW2_ESTIMATE_RUN_ID || !ROW2_BATCH_ID) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ROW2_ESTIMATE_RUN_ID, ROW2_BATCH_ID must all be set' }))
  process.exit(1)
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

async function main() {
  // Identical client construction to app/api/cron/intake-recovery/route.ts:
  // createClient(supabaseUrl, supabaseKey) with the service role key.
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  log('test_started', { row2_estimate_run_id: ROW2_ESTIMATE_RUN_ID, row2_batch_id: ROW2_BATCH_ID })

  // ── BEFORE state (read via PostgREST too, for an apples-to-apples read) ──
  const { data: beforeRow, error: beforeErr } = await supabase
    .from('estimate_runs')
    .select('id, deadline_at, deadline_extensions_used, builder_status, watchdog_consecutive_misses, watchdog_total_misses')
    .eq('id', ROW2_ESTIMATE_RUN_ID)
    .single()
  log('before_state', { row: beforeRow, error: beforeErr?.message ?? null })

  // ── Call 1: record_watchdog_post_tick() — global, no args, exactly as
  // route.ts calls it. This will also touch ROW 2 if it's eligible. ──
  const { data: watchdogData, error: watchdogErr, status: watchdogStatus } = await supabase.rpc('record_watchdog_post_tick')
  const watchdogRowMatch = Array.isArray(watchdogData) ? watchdogData.find((r) => r.estimate_run_id === ROW2_ESTIMATE_RUN_ID) : null
  log('rpc_call_record_watchdog_post_tick', {
    http_status: watchdogStatus,
    error: watchdogErr?.message ?? null,
    total_rows_returned: Array.isArray(watchdogData) ? watchdogData.length : null,
    row2_present_in_result: Boolean(watchdogRowMatch),
    row2_result_row: watchdogRowMatch ?? null,
  })

  // ── Call 2: enforce_estimate_deadlines() — exactly as route.ts calls it ──
  const { data: enforceData, error: enforceErr, status: enforceStatus } = await supabase.rpc('enforce_estimate_deadlines')
  const enforceRowMatch = Array.isArray(enforceData) ? enforceData.find((r) => r.estimate_run_id === ROW2_ESTIMATE_RUN_ID) : null
  log('rpc_call_enforce_estimate_deadlines', {
    http_status: enforceStatus,
    error: enforceErr?.message ?? null,
    total_rows_returned: Array.isArray(enforceData) ? enforceData.length : null,
    row2_present_in_result: Boolean(enforceRowMatch),
    row2_result_row: enforceRowMatch ?? null,
    full_response_body: enforceData,
  })

  // ── AFTER state, to check whether ROW 2 was actually modified (extended
  // or finalized) regardless of whether it appeared in the RETURN NEXT
  // result set (extensions are silently not returned, per the function's
  // own design — only finalizations are). ──
  const { data: afterRow, error: afterErr } = await supabase
    .from('estimate_runs')
    .select('id, deadline_at, deadline_extensions_used, builder_status, completed_at, watchdog_consecutive_misses, watchdog_total_misses, watchdog_first_eligible_at')
    .eq('id', ROW2_ESTIMATE_RUN_ID)
    .single()
  log('after_state_post_enforce_and_watchdog', { row: afterRow, error: afterErr?.message ?? null })

  const rowWasModified = beforeRow && afterRow && (
    beforeRow.deadline_at !== afterRow.deadline_at ||
    beforeRow.deadline_extensions_used !== afterRow.deadline_extensions_used ||
    beforeRow.builder_status !== afterRow.builder_status
  )
  log('row_modification_check', { row_was_modified: rowWasModified })

  // ── Call 3: find_stuck_batches_needing_classification_retry() — exactly
  // as route.ts's step 5 calls it (no args). ──
  const { data: stuckData, error: stuckErr, status: stuckStatus } = await supabase.rpc('find_stuck_batches_needing_classification_retry')
  const stuckRowMatch = Array.isArray(stuckData) ? stuckData.find((r) => r.batch_id === ROW2_BATCH_ID) : null
  log('rpc_call_find_stuck_batches_needing_classification_retry', {
    http_status: stuckStatus,
    error: stuckErr?.message ?? null,
    total_rows_returned: Array.isArray(stuckData) ? stuckData.length : null,
    row2_batch_present_in_result: Boolean(stuckRowMatch),
    row2_result_row: stuckRowMatch ?? null,
  })

  log('test_complete', {
    summary: {
      record_watchdog_post_tick_saw_row2: Boolean(watchdogRowMatch),
      enforce_estimate_deadlines_saw_row2: Boolean(enforceRowMatch),
      enforce_estimate_deadlines_modified_row2: rowWasModified,
      find_stuck_batches_saw_row2_batch: Boolean(stuckRowMatch),
    },
  })
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'test_failed', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
