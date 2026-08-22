#!/usr/bin/env node
// ============================================================
// WorkA — reset the global AI circuit breaker, but only after confirming
// the batch that tripped it has reached a safe, terminal, non-retriable
// state (so resetting can't immediately let it re-trip).
// ============================================================
// One-off tool, matching the manual procedure used earlier in this session
// for the 60ea9c63 incident. Reads system_status.ai_circuit_breaker, finds
// the batch id named in its reason string, confirms that batch's
// estimate_runs.builder_status is finalized (so it's permanently excluded
// from find_stuck_batches_needing_classification_retry / find_batches_
// with_claimable_work per migration 078) before resetting. Refuses to
// reset if the offending batch is not yet terminal.
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/reset-circuit-breaker-if-safe.mjs
// ============================================================

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY required' }))
    process.exit(1)
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: row, error } = await supabase
    .from('system_status')
    .select('key, value, updated_at')
    .eq('key', 'ai_circuit_breaker')
    .single()
  if (error) throw error
  log('breaker_state', { value: row.value, updated_at: row.updated_at })

  if (!row.value?.tripped) {
    log('breaker_not_tripped', { message: 'nothing to do' })
    process.exit(0)
  }

  const reason = row.value.reason ?? ''
  const match = reason.match(/batch ([0-9a-f-]{36})/)
  if (!match) {
    log('refusing_reset', { message: 'could not extract a batch id from the breaker reason -- refusing to reset without confirming safety', reason })
    process.exit(1)
  }
  const batchId = match[1]

  const { data: run, error: runErr } = await supabase
    .from('estimate_runs')
    .select('id, status, builder_status, completed_at')
    .eq('batch_id', batchId)
    .maybeSingle()
  if (runErr) throw runErr
  log('offending_batch_estimate_run', { batch_id: batchId, estimate_run: run ?? null })

  if (!run || !run.builder_status) {
    log('refusing_reset', { message: 'offending batch has no finalized builder_status yet -- it could still be retried and immediately re-trip the breaker. Not resetting.', batch_id: batchId })
    process.exit(1)
  }

  const { data: stuck } = await supabase.rpc('find_stuck_batches_needing_classification_retry')
  const stillEligible = (stuck ?? []).some((b) => b.batch_id === batchId)
  if (stillEligible) {
    log('refusing_reset', { message: "offending batch is STILL showing as eligible for classification retry despite a finalized builder_status -- this should be impossible per migration 078's exclusion; refusing to reset until this is understood", batch_id: batchId })
    process.exit(1)
  }

  const { error: updateErr } = await supabase
    .from('system_status')
    .update({ value: { tripped: false, reason: null }, updated_at: new Date().toISOString() })
    .eq('key', 'ai_circuit_breaker')
  if (updateErr) throw updateErr

  log('breaker_reset', {
    batch_id: batchId, builder_status: run.builder_status, completed_at: run.completed_at,
    message: 'offending batch has a finalized, terminal builder_status and is permanently excluded from further automatic retry -- safe to reset',
  })
  process.exit(0)
}

main()
