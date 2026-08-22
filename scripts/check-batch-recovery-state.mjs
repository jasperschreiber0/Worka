#!/usr/bin/env node
// ============================================================
// WorkA — read-only diagnostic: is a given batch eligible for
// endless recovery retriggering, and what's the breaker's state?
// ============================================================
// One-off tool for the 60ea9c63 poisoned-batch incident (see CLAUDE.md
// "Independent Intake Recovery Service" / the Stage 1/2 failure-counter
// gap). Read-only — makes no writes, no Anthropic calls. Takes the batch
// id from BATCH_ID env var.
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   BATCH_ID=60ea9c63-96ba-40b5-be2c-37c01fb33f01 \
//   node scripts/check-batch-recovery-state.mjs
// ============================================================

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BATCH_ID = process.env.BATCH_ID

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !BATCH_ID) {
    console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BATCH_ID required' }))
    process.exit(1)
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: batch, error: batchErr } = await supabase
    .from('document_processing_batches')
    .select('id, job_id, builder_id, status, stall_stage, stall_reason, stalled_at, stall_count, scope_reasoning_completed_at, stage3_failure_count, stage6_failure_count, total_ai_call_attempts, classification_triggered, quote_id, updated_at, created_at')
    .eq('id', BATCH_ID)
    .maybeSingle()
  log('batch_state', { batch, error: batchErr?.message ?? null })

  if (batch) {
    const { data: files, error: filesErr } = await supabase
      .from('files')
      .select('id, filename, intake_status, failure_stage, failure_reason, ai_failure_classification, ai_failure_count, intake_recovery_attempts, processing_batch_id')
      .eq('job_id', batch.job_id)
    log('files_state', { job_id: batch.job_id, files: files ?? null, error: filesErr?.message ?? null })

    const { data: docJobs, error: docJobsErr } = await supabase
      .from('document_processing_jobs')
      .select('id, document_id, status, attempts, error_message, locked_at, locked_by')
      .eq('parent_job_id', BATCH_ID)
    log('document_processing_jobs_state', { batch_id: BATCH_ID, jobs: docJobs ?? null, error: docJobsErr?.message ?? null })
    const { data: lock } = await supabase
      .from('job_intake_locks')
      .select('job_id, file_id, started_at, last_progress_at')
      .eq('job_id', batch.job_id)
      .maybeSingle()
    log('job_intake_lock_state', { job_id: batch.job_id, lock: lock ?? null })

    const { data: run } = await supabase
      .from('estimate_runs')
      .select('id, status, builder_status, deadline_at, completed_at, needs_review_reason, stall_reason, failure_reason, reconciled_at, deadline_extensions_used')
      .eq('batch_id', BATCH_ID)
      .maybeSingle()
    log('estimate_run_state', { batch_id: BATCH_ID, estimate_run: run ?? null })
  }

  const { data: statusRows } = await supabase
    .from('system_status')
    .select('key, value, updated_at')
    .in('key', ['ai_circuit_breaker', 'ai_limits'])
  log('circuit_breaker_state', { status_rows: statusRows ?? null })

  const { data: stuckBatches, error: stuckErr } = await supabase.rpc('find_stuck_batches_needing_classification_retry')
  const eligible = (stuckBatches ?? []).some((b) => b.batch_id === BATCH_ID)
  log('recovery_eligibility', {
    batch_id: BATCH_ID, currently_eligible_for_classification_retry: eligible,
    total_stuck_batches_found: (stuckBatches ?? []).length, error: stuckErr?.message ?? null,
  })

  const { data: staleLocks, error: staleErr } = await supabase.rpc('find_stale_job_intake_locks')
  const lockStale = (staleLocks ?? []).some((l) => l.job_id === batch?.job_id)
  log('stale_lock_eligibility', {
    job_id: batch?.job_id ?? null, currently_matches_stale_lock_reclaim: lockStale,
    total_stale_locks_found: (staleLocks ?? []).length, error: staleErr?.message ?? null,
  })

  process.exit(0)
}

main()
