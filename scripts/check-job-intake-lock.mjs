#!/usr/bin/env node
// ONE-TIME, read-only: why did GET /api/intake stay stuck at 'queued' for
// job 1f12de7f during the batching-fix verification run? Checks the current
// job_intake_locks row for this job directly (not scoped to any specific
// document_processing_batches id, unlike check-batch-recovery-state.mjs).
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const JOB_ID = process.env.CHECK_JOB_ID || '1f12de7f-47b5-442e-9581-1f813796eb70'

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: lock, error: lockErr } = await supabase
    .from('job_intake_locks')
    .select('*')
    .eq('job_id', JOB_ID)
    .maybeSingle()
  log('job_intake_lock', { job_id: JOB_ID, lock, error: lockErr?.message ?? null, now: new Date().toISOString() })

  const { data: staleLocks, error: staleErr } = await supabase.rpc('find_stale_job_intake_locks')
  log('stale_locks_rpc', {
    total: (staleLocks ?? []).length,
    matches_this_job: (staleLocks ?? []).some((l) => l.job_id === JOB_ID),
    all: staleLocks ?? null,
    error: staleErr?.message ?? null,
  })

  const { data: recentBatches } = await supabase
    .from('document_processing_batches')
    .select('id, status, created_at, updated_at, classification_triggered, stall_stage, stalled_at')
    .eq('job_id', JOB_ID)
    .order('created_at', { ascending: false })
    .limit(5)
  log('recent_batches', { batches: recentBatches ?? null })

  const { data: recentFiles } = await supabase
    .from('files')
    .select('id, filename, intake_status, created_at, processing_batch_id')
    .eq('job_id', JOB_ID)
    .order('created_at', { ascending: false })
    .limit(10)
  log('recent_files', { files: recentFiles ?? null })

  process.exit(0)
}

main().catch((err) => {
  console.log(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
