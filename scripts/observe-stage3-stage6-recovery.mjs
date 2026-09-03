#!/usr/bin/env node
// ============================================================
// ONE-TIME, READ-ONLY observation of the existing production recovery
// mechanism (pg_cron -> GET /api/cron/intake-recovery, every ~1 minute,
// migrations 038/044) taking the now-complete Stage 1/2 job through
// Stage 3 -> Stage 6 -> final quote state.
//
// Performs ZERO writes and ZERO triggers of its own: no /api/intake call,
// no direct RPC invocation, no Claude call, no DB mutation. It only reads
// job_intake_locks, document_processing_batches, document_processing_jobs,
// ai_operations, project_documents, project_facts, quotes,
// quote_line_items, and intake_recovery_runs on a poll loop, logging a
// snapshot every time anything relevant changes, so the REAL recovery
// mechanism's own behaviour is what gets traced -- not a synthetic retry.
// ============================================================
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const JOB_ID = '1f12de7f-47b5-442e-9581-1f813796eb70'
const QUOTE_ID = '48f8dc8b-181d-43e4-9512-70ae6e22c701'
const TARGET_FILE_ID = 'f2b240fb-5be7-4931-b795-4d140c1c7e63'

const OBSERVE_MS = Number(process.env.OBSERVE_MS || 20 * 60_000)
const POLL_INTERVAL_MS = 15_000

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function snapshot(label) {
  const { data: fileRow } = await supabase
    .from('files')
    .select('id, intake_status, intake_stage, intake_pct, ai_failure_classification, ai_failure_count, failure_stage, failure_reason, processing_batch_id')
    .eq('id', TARGET_FILE_ID)
    .single()

  const { data: lockRow } = await supabase
    .from('job_intake_locks')
    .select('*')
    .eq('job_id', JOB_ID)
    .maybeSingle()

  let batchRow = null
  let batchJobs = []
  if (fileRow?.processing_batch_id) {
    const { data: b } = await supabase
      .from('document_processing_batches')
      .select('id, status, classification_triggered, quote_id, created_at, updated_at, stall_stage, stall_reason, stalled_at, stall_count, scope_reasoning_completed_at, stage3_completed_trade_ids, stage6_completed_trade_ids, stage6_active_calls, total_ai_call_attempts')
      .eq('id', fileRow.processing_batch_id)
      .maybeSingle()
    batchRow = b
    const { data: jobs } = await supabase
      .from('document_processing_jobs')
      .select('id, document_id, status, attempts, last_error, locked_by')
      .eq('parent_job_id', fileRow.processing_batch_id)
    batchJobs = jobs ?? []
  }

  const { data: recentOps } = await supabase
    .from('ai_operations')
    .select('id, call_site, status, output_tokens, duration_ms, cost_cents, error_classification, error_message, created_at')
    .like('scope_key', `${JOB_ID}:%`)
    .order('created_at', { ascending: false })
    .limit(6)

  const { data: recoveryRuns } = await supabase
    .from('intake_recovery_runs')
    .select('id, run_started_at, run_finished_at, document_jobs_reclaimed, batches_resumed, job_locks_reclaimed, stuck_files_retried, files_permanently_failed, errors')
    .order('run_started_at', { ascending: false })
    .limit(3)

  const { data: docs } = await supabase.from('project_documents').select('id, file_id, extraction_status').eq('job_id', JOB_ID)
  const { data: facts } = await supabase.from('project_facts').select('id, superseded').eq('job_id', JOB_ID)
  const { data: quote } = await supabase.from('quotes').select('id, status, total_cost, overall_confidence, is_current, version, qa_report').eq('id', QUOTE_ID).maybeSingle()
  const { data: lineItems } = await supabase.from('quote_line_items').select('id, total, assumption_status').eq('quote_id', QUOTE_ID)

  const snap = {
    label,
    target_file: fileRow,
    job_intake_lock: lockRow ?? null,
    target_batch: batchRow,
    batch_jobs: batchJobs,
    recent_ai_operations: recentOps ?? [],
    recent_recovery_runs: recoveryRuns ?? [],
    project_documents_count: docs?.length ?? 0,
    project_facts_total: facts?.length ?? 0,
    project_facts_active: (facts ?? []).filter((f) => !f.superseded).length,
    quote: quote ? { ...quote, qa_report: quote.qa_report ? '[present]' : null } : null,
    quote_line_items_count: lineItems?.length ?? 0,
  }
  return snap
}

async function main() {
  log('observation_started', { job_id: JOB_ID, quote_id: QUOTE_ID, target_file_id: TARGET_FILE_ID, observe_ms: OBSERVE_MS })

  const initial = await snapshot('initial')
  log('current_state_before_resumption', initial)

  let last = JSON.stringify(initial)
  const deadline = Date.now() + OBSERVE_MS
  let terminalReached = false

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const snap = await snapshot('poll')
    const str = JSON.stringify(snap)
    if (str !== last) {
      log('state_change_observed', snap)
      last = str
    }

    // Truthful terminal conditions: quote priced+QA'd with fresh facts, OR
    // the file reaches a terminal intake_status other than 'processing'.
    const stage6Reached = snap.quote?.total_cost != null && snap.quote?.qa_report != null && snap.project_facts_total > 16
    const fileTerminal = ['extracted', 'needs_info', 'failed'].includes(snap.target_file?.intake_status)
    if (stage6Reached || fileTerminal) {
      log('terminal_condition_reached', { stage6_reached: stage6Reached, file_terminal: fileTerminal })
      terminalReached = true
      break
    }
  }

  if (!terminalReached) {
    log('observation_window_elapsed_no_terminal_state', { message: 'Observation window ended without a truthful terminal state -- this is reported as-is, not treated as success or failure.' })
  }

  const final = await snapshot('final')
  const { data: finalLineItems } = await supabase.from('quote_line_items').select('id, total, assumption_status').eq('quote_id', QUOTE_ID)
  const recomputedTotal = (finalLineItems ?? [])
    .filter((li) => li.assumption_status !== 'excluded')
    .reduce((sum, li) => sum + (li.total ?? 0), 0)
  log('final_state', {
    ...final,
    quote_total_cost_cached: final.quote?.total_cost ?? null,
    quote_total_cost_recomputed_from_line_items: recomputedTotal,
    quote_totals_consistent: final.quote?.total_cost != null && Math.abs((final.quote.total_cost ?? 0) - recomputedTotal) < 0.01,
  })

  log('done', { job_id: JOB_ID, terminal_reached: terminalReached })
}

main().catch((err) => {
  console.log(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
