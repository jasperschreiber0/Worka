#!/usr/bin/env node
// ONE-TIME, read-only pre-verification check for the Stage 1/2
// truncation-recovery fix (commit f9b0233). Confirms the exact CURRENT
// persisted state of the target file (16 Alfred Street Woonona DA-Mod PDF,
// f2b240fb-5be7-4931-b795-4d140c1c7e63) before any retrigger — specifically
// whether its ai_failure_classification/ai_failure_count already reflect
// truncated_response (eligible for the raised-budget recovery attempt on
// the very next invocation) or still reflect the pre-fix 'unknown'
// misclassification from before this deploy (in which case the next
// retrigger will first need to re-observe and correctly reclassify the
// same truncation before recovery becomes eligible on a LATER invocation).
// Zero writes, zero Anthropic calls.
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const JOB_ID = '1f12de7f-47b5-442e-9581-1f813796eb70'
const TARGET_FILE_ID = 'f2b240fb-5be7-4931-b795-4d140c1c7e63'

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

async function main() {
  const { data: fileRow, error: fileErr } = await supabase
    .from('files')
    .select('id, filename, intake_status, intake_stage, intake_pct, ai_failure_classification, ai_failure_count, failure_stage, failure_reason, processing_batch_id, created_at')
    .eq('id', TARGET_FILE_ID)
    .maybeSingle()
  log('target_file_state', { found: !!fileRow, error: fileErr?.message ?? null, row: fileRow ?? null })

  const { data: lockRow } = await supabase
    .from('job_intake_locks')
    .select('*')
    .eq('job_id', JOB_ID)
    .maybeSingle()
  log('job_intake_lock_state', { row: lockRow ?? null })

  let batchRow = null
  let batchJobs = []
  if (fileRow?.processing_batch_id) {
    const { data: b } = await supabase
      .from('document_processing_batches')
      .select('*')
      .eq('id', fileRow.processing_batch_id)
      .maybeSingle()
    batchRow = b
    const { data: jobs } = await supabase
      .from('document_processing_jobs')
      .select('id, document_id, status, attempts, last_error, locked_by, updated_at')
      .eq('parent_job_id', fileRow.processing_batch_id)
    batchJobs = jobs ?? []
  }
  log('processing_batch_state', { batch: batchRow, jobs: batchJobs })

  const { data: projectDoc } = await supabase
    .from('project_documents')
    .select('id, file_id, extraction_status, document_type, created_at')
    .eq('job_id', JOB_ID)
    .eq('file_id', TARGET_FILE_ID)
    .maybeSingle()
  log('project_document_state', { row: projectDoc ?? null })

  const { data: recentOps } = await supabase
    .from('ai_operations')
    .select('id, call_site, status, output_tokens, duration_ms, error_classification, error_message, created_at')
    .like('scope_key', `${JOB_ID}:%`)
    .order('created_at', { ascending: false })
    .limit(10)
  log('recent_ai_operations_for_job', { rows: recentOps ?? [] })

  const { data: quoteRow } = await supabase
    .from('quotes')
    .select('id, status, total_cost, overall_confidence, is_current, version')
    .eq('job_id', JOB_ID)
    .eq('is_current', true)
    .maybeSingle()
  log('current_quote_state', { row: quoteRow ?? null })

  log('interpretation', {
    eligible_for_recovery_now: fileRow?.ai_failure_classification === 'truncated_response' && fileRow?.ai_failure_count === 1,
    note: fileRow?.ai_failure_classification === 'unknown'
      ? 'Pre-fix history: recorded as unknown before this deploy. A retrigger now will re-attempt at the DEFAULT budget first (isForcedSolo already true from count>=1, but isTruncationRecoveryEligible requires classification===truncated_response), correctly reclassify a truncation as truncated_response this time, and only become eligible for the raised-budget recovery attempt on a LATER invocation.'
      : fileRow?.ai_failure_classification === 'truncated_response'
        ? 'Already correctly classified truncated_response — a retrigger now should be eligible for the raised-budget (20000/280000ms) recovery attempt on this very next invocation, if count === 1.'
        : 'Unexpected classification state — inspect row directly before proceeding.',
  })
}

main().catch((err) => {
  console.log(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
