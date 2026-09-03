#!/usr/bin/env node
// ONE-TIME, READ-ONLY: evaluates every individual clause of
// find_stuck_batches_needing_classification_retry (migration 088) against
// the real target batch, to pinpoint EXACTLY which clause (if any) is
// excluding it, rather than inferring from a single field. Zero writes.
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const JOB_ID = '1f12de7f-47b5-442e-9581-1f813796eb70'
const TARGET_FILE_ID = 'f2b240fb-5be7-4931-b795-4d140c1c7e63'

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
function log(event, data = {}) { console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data })) }

async function main() {
  const { data: fileRow } = await supabase.from('files').select('id, processing_batch_id, ai_failure_count, ai_failure_classification').eq('id', TARGET_FILE_ID).single()
  const batchId = fileRow.processing_batch_id
  log('target_file', fileRow)

  const { data: batch } = await supabase
    .from('document_processing_batches')
    .select('id, job_id, builder_id, primary_file_id, status, classification_triggered, updated_at, stage3_failure_count, stage6_failure_count, quote_id')
    .eq('id', batchId)
    .single()
  log('batch_row', batch)

  // Clause 1: status IN (...)
  const clauseStatus = ['completed', 'completed_with_failures', 'failed'].includes(batch.status)
  // Clause 2: classification_triggered = true
  const clauseTriggered = batch.classification_triggered === true
  // Clause 3: updated_at < now() - 3min
  const graceMs = 3 * 60_000
  const clauseGrace = (Date.now() - new Date(batch.updated_at).getTime()) > graceMs
  // Clause 4: stage3_failure_count = 0
  const clauseStage3 = batch.stage3_failure_count === 0
  // Clause 5: stage6_failure_count = 0
  const clauseStage6 = batch.stage6_failure_count === 0
  // Clause 6: NOT EXISTS job_intake_locks for this job
  const { data: lock } = await supabase.from('job_intake_locks').select('*').eq('job_id', batch.job_id).maybeSingle()
  const clauseNoLock = !lock
  // Clause 7: NOT EXISTS estimate_runs with builder_status IS NOT NULL for this batch_id
  const { data: estimateRuns } = await supabase.from('estimate_runs').select('id, batch_id, builder_status, created_at, updated_at').eq('batch_id', batchId)
  const clauseNoFinalizedEstimateRun = !(estimateRuns ?? []).some((r) => r.builder_status != null)
  // Clause 8 (migration 102): NOT EXISTS a document_processing_jobs row
  // joined to a file with ai_failure_count > 0 AND no project_documents
  // row with extraction_status='complete' for that same file.
  const { data: jobsForBatch } = await supabase.from('document_processing_jobs').select('id, document_id, status, attempts').eq('parent_job_id', batchId)
  let clauseNoFailedDoc = true
  const failedDocs = []
  for (const j of jobsForBatch ?? []) {
    const { data: f } = await supabase.from('files').select('id, ai_failure_count, ai_failure_classification').eq('id', j.document_id).maybeSingle()
    if (f && f.ai_failure_count > 0) {
      const { data: pd } = await supabase.from('project_documents').select('id, extraction_status').eq('file_id', f.id).eq('extraction_status', 'complete')
      const hasCompleted = (pd ?? []).length > 0
      if (!hasCompleted) {
        clauseNoFailedDoc = false
        failedDocs.push({ document_id: j.document_id, ai_failure_count: f.ai_failure_count, ai_failure_classification: f.ai_failure_classification, has_completed_project_documents_row: hasCompleted })
      }
    }
  }

  log('clause_evaluation', {
    clause_status_in_terminal_set: clauseStatus,
    clause_classification_triggered: clauseTriggered,
    clause_past_grace_period: clauseGrace,
    batch_updated_at: batch.updated_at,
    now_minus_batch_updated_at_ms: Date.now() - new Date(batch.updated_at).getTime(),
    clause_stage3_failure_count_zero: clauseStage3,
    clause_stage6_failure_count_zero: clauseStage6,
    clause_no_job_intake_lock: clauseNoLock,
    job_intake_lock_row: lock ?? null,
    clause_no_finalized_estimate_run: clauseNoFinalizedEstimateRun,
    estimate_runs_for_batch: estimateRuns ?? [],
    clause_no_failed_doc_via_document_processing_jobs_join: clauseNoFailedDoc,
    document_processing_jobs_count_for_batch: jobsForBatch?.length ?? 0,
    document_processing_jobs_rows: jobsForBatch ?? [],
    failed_docs_found_via_join: failedDocs,
  })

  const wouldBeReturnedByCurrentPredicate =
    clauseStatus && clauseTriggered && clauseGrace && clauseStage3 && clauseStage6 &&
    clauseNoLock && clauseNoFinalizedEstimateRun && clauseNoFailedDoc

  log('final_verdict', {
    would_be_returned_by_current_find_stuck_batches_predicate: wouldBeReturnedByCurrentPredicate,
    interpretation: wouldBeReturnedByCurrentPredicate
      ? 'This batch SHOULD already be discoverable by the current predicate -- if pg_cron is still not resuming it, the blocker is elsewhere (route-level gating, RPC call failure, or something not modeled by this script).'
      : 'This batch is excluded by the current predicate -- see which clause(s) above are false to identify the exact blocking condition.',
  })

  // Also directly confirm: does calling the RPC itself (as the real route
  // does, via PostgREST) return this batch right now? This is the ground
  // truth, not a hand-rolled equivalent of the SQL.
  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/find_stuck_batches_needing_classification_retry`, {
    method: 'POST',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const rpcBody = await rpcRes.json().catch(() => null)
  log('live_rpc_call_result', {
    status: rpcRes.status,
    ok: rpcRes.ok,
    total_batches_returned: Array.isArray(rpcBody) ? rpcBody.length : null,
    target_batch_present: Array.isArray(rpcBody) ? rpcBody.some((r) => r.batch_id === batchId) : null,
    body_sample: Array.isArray(rpcBody) ? rpcBody.slice(0, 5) : rpcBody,
  })
}

main().catch((err) => {
  console.log(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
