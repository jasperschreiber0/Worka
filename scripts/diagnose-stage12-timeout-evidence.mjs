#!/usr/bin/env node
// ============================================================
// ONE-TIME, read-only diagnostic (not a recurring health check) — resolves
// the "chunking candidate vs wider-timeout candidate" question for the real
// job stuck on repeated stage_document_intelligence application_timeout
// failures (job 1f12de7f-47b5-442e-9581-1f813796eb70). Zero writes, zero
// Anthropic calls. Traces the exact files/document_processing_jobs/
// document_processing_batches rows involved so the timeout-vs-chunking
// decision is made from real byte size / page count / block type evidence,
// not inference from file ordering.
// ============================================================

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const JOB_ID = process.env.DIAGNOSE_JOB_ID || '1f12de7f-47b5-442e-9581-1f813796eb70'

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY must be set' }))
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

async function main() {
  const { data: files, error: filesErr } = await supabase
    .from('files')
    .select('id, filename, file_type, file_size_bytes, content_hash, duplicate_of_file_id, intake_status, intake_stage, intake_pct, ai_failure_classification, ai_failure_count, failure_stage, failure_reason, processing_batch_id, created_at')
    .eq('job_id', JOB_ID)
    .order('created_at', { ascending: true })
  if (filesErr) {
    log('files_query_failed', { error: filesErr.message })
    process.exit(1)
  }
  log('files_full', { count: files?.length ?? 0, files })

  const fileIds = (files ?? []).map((f) => f.id)

  const { data: batches, error: batchesErr } = await supabase
    .from('document_processing_batches')
    .select('id, primary_file_id, status, classification_triggered, quote_id, created_at, updated_at, stall_stage, stall_reason, stalled_at, stall_count, scope_reasoning_completed_at')
    .eq('job_id', JOB_ID)
    .order('created_at', { ascending: true })
  if (batchesErr) {
    log('batches_query_failed', { error: batchesErr.message })
  } else {
    log('document_processing_batches', { count: batches?.length ?? 0, batches })
  }

  const { data: jobs, error: jobsErr } = await supabase
    .from('document_processing_jobs')
    .select('id, parent_job_id, document_id, status, attempts, error_message, run_after, locked_at, started_at, completed_at, result, created_at, updated_at')
    .in('document_id', fileIds.length > 0 ? fileIds : ['00000000-0000-0000-0000-000000000000'])
    .order('created_at', { ascending: true })
  if (jobsErr) {
    log('document_processing_jobs_query_failed', { error: jobsErr.message })
  } else {
    log('document_processing_jobs', {
      count: jobs?.length ?? 0,
      jobs: (jobs ?? []).map((j) => ({
        id: j.id, parent_job_id: j.parent_job_id, document_id: j.document_id,
        status: j.status, attempts: j.attempts, error_message: j.error_message,
        started_at: j.started_at, completed_at: j.completed_at,
        result_blockType: j.result?.blockType ?? null,
        result_pageCount: j.result?.pageCount ?? null,
        result_hasUsableText: j.result?.hasUsableText ?? null,
        result_durationMs: j.result?.durationMs ?? null,
        result_duplicate: j.result?.duplicate ?? false,
      })),
    })
  }

  // Group document_processing_jobs by parent batch so it's explicit which
  // files were bundled together for the SAME Stage 1/2 attempt (batching
  // groups at the smooth-responder classifyBatch level, not at the
  // document-worker extraction level, but every job sharing a
  // parent_job_id went through the same batch's extraction phase and is a
  // candidate for having been grouped into the same Claude call).
  const byBatch = new Map()
  for (const j of jobs ?? []) {
    if (!byBatch.has(j.parent_job_id)) byBatch.set(j.parent_job_id, [])
    byBatch.get(j.parent_job_id).push(j)
  }
  for (const [batchId, batchJobs] of Array.from(byBatch.entries())) {
    const totalPageCount = batchJobs.reduce((sum, j) => sum + (j.result?.pageCount ?? 0), 0)
    const fileSizes = batchJobs.map((j) => (files ?? []).find((f) => f.id === j.document_id)?.file_size_bytes ?? null)
    const totalBytes = fileSizes.reduce((sum, b) => sum + (b ?? 0), 0)
    log('batch_grouping_summary', {
      parent_job_id: batchId,
      document_count: batchJobs.length,
      total_page_count: totalPageCount,
      total_file_size_bytes: totalBytes,
      block_types: batchJobs.map((j) => j.result?.blockType ?? null),
      filenames: batchJobs.map((j) => (files ?? []).find((f) => f.id === j.document_id)?.filename ?? null),
    })
  }

  // Real ai_operations for this job, re-fetched fresh (not assumed from an
  // earlier run) so failure timestamps can be matched against the batch/job
  // timestamps above.
  const { data: ops, error: opsErr } = await supabase
    .from('ai_operations')
    .select('id, call_site, status, cost_cents, error_classification, created_at, scope_key')
    .like('scope_key', `${JOB_ID}:%`)
    .order('created_at', { ascending: true })
  if (opsErr) {
    log('ai_operations_query_failed', { error: opsErr.message })
  } else {
    log('ai_operations_full', { count: ops?.length ?? 0, ops })
  }

  log('done', { job_id: JOB_ID })
}

main().catch((err) => {
  console.log(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
