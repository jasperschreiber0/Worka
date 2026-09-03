#!/usr/bin/env node
// ONE-TIME, READ-ONLY: the deployed migration-102 fix passed in isolation
// (synthetic regression test) but the live RPC still excludes the REAL
// target batch. Investigates exactly why by inspecting, for every document
// tied to the batch, the precise project_documents row(s) matched by
// file_id -- looking for a mismatch (missing row, wrong extraction_status,
// duplicate rows, chunk-suffixed id) rather than assuming the fix is
// broken. Zero writes.
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BATCH_ID = 'ac0380e4-b74b-46f0-ab9e-e42de35e71c8'
const TARGET_FILE_ID = 'f2b240fb-5be7-4931-b795-4d140c1c7e63'
const JOB_ID = '1f12de7f-47b5-442e-9581-1f813796eb70'

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
function log(event, data = {}) { console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data })) }

async function main() {
  const { data: jobs } = await supabase
    .from('document_processing_jobs')
    .select('id, document_id, status')
    .eq('parent_job_id', BATCH_ID)
  log('document_processing_jobs_for_batch', { count: jobs?.length ?? 0, rows: jobs })

  for (const j of jobs ?? []) {
    const { data: f } = await supabase.from('files').select('id, ai_failure_count, ai_failure_classification, intake_status').eq('id', j.document_id).maybeSingle()
    const { data: pdRows, error: pdErr } = await supabase.from('project_documents').select('id, file_id, job_id, extraction_status, created_at').eq('file_id', j.document_id)
    log('document_detail', {
      document_id: j.document_id,
      file_row: f,
      project_documents_matching_this_file_id: pdRows,
      project_documents_query_error: pdErr?.message ?? null,
    })
  }

  // Also dump every project_documents row for the whole job, regardless of
  // file_id match, to catch anything with a slightly different id (chunk
  // suffix, whitespace, case) that a straight .eq() would miss.
  const { data: allJobDocs } = await supabase.from('project_documents').select('id, file_id, job_id, extraction_status, created_at').eq('job_id', JOB_ID)
  log('all_project_documents_for_job', { count: allJobDocs?.length ?? 0, rows: allJobDocs })

  // Re-confirm the batch's own current row (has anything about it changed
  // since the earlier check moments ago?).
  const { data: batchRow } = await supabase.from('document_processing_batches').select('*').eq('id', BATCH_ID).single()
  log('batch_row_now', batchRow)

  // Directly re-run the live RPC once more, immediately after this
  // read, for a same-second comparison point.
  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/find_stuck_batches_needing_classification_retry`, {
    method: 'POST',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const rpcBody = await rpcRes.json().catch(() => null)
  log('live_rpc_recheck', {
    status: rpcRes.status,
    total_returned: Array.isArray(rpcBody) ? rpcBody.length : null,
    target_present: Array.isArray(rpcBody) ? rpcBody.some((r) => r.batch_id === BATCH_ID) : null,
    all_returned_batch_ids: Array.isArray(rpcBody) ? rpcBody.map((r) => r.batch_id) : rpcBody,
  })

}

main().catch((err) => {
  console.log(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
