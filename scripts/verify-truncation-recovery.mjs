#!/usr/bin/env node
// ============================================================
// ONE-TIME production verification of the Stage 1/2 truncation-recovery fix
// (commit f9b0233), approved after AskUserQuestion confirmed the correction
// step below. Target job/file, per the approved plan:
//   job_id:  1f12de7f-47b5-442e-9581-1f813796eb70
//   file:    f2b240fb-5be7-4931-b795-4d140c1c7e63 (16 Alfred Street Woonona
//            DA-Mod-250526 (2).pdf)
//
// WHY A CORRECTION STEP IS NEEDED (evidence, not assumption): a read-only
// pre-state check (scripts/check-truncation-recovery-pre-state.mjs) proved
// this exact file already carries files.intake_status = 'failed' with
// ai_failure_classification = 'unknown', ai_failure_count = 1 — recorded
// BEFORE this fix deployed, when callTool's truncation throw (confirmed via
// the raw ai_operations.result recovered in the earlier forensic
// investigation: stop_reason:'max_tokens', a valid non-null tool_use block,
// output_tokens:16000, duration_ms:212335 for op 821048cc-...) was
// misclassified 'unknown' instead of 'truncated_response'. Because
// maxConsecutiveOccurrences('unknown') === 0 (zero retry tolerance), the
// file was marked permanently intake_status='failed' on that first
// occurrence — and every retrigger path (this route included) excludes any
// file with intake_status==='failed' before classifyBatch is ever reached
// again. A bare retrigger therefore cannot exercise the fix for this file
// at all: it would just be silently skipped.
//
// The correction below does exactly ONE thing: fixes the file's
// ai_failure_classification to what the ALREADY-RECOVERED RAW EVIDENCE
// proves it actually was (truncated_response, not unknown), leaves
// ai_failure_count unchanged at 1 (accurate — it really did fail once), and
// clears the terminal intake_status/failure_stage/failure_reason fields so
// the file is retriable again — i.e. restores the file to the state it
// would be in RIGHT NOW had this fix existed at the time of that original
// failure. It does NOT inject a second, fabricated failure, and does NOT
// touch ai_operations, project_documents, project_facts, quotes, or any
// other job's data. This is a database correction, not a code change, and
// is the SAME target job/file/document specified throughout this
// verification, per the user's explicit approval of this exact plan.
//
// After the correction, this script performs exactly ONE retrigger via the
// REAL GET /api/intake/[fileId] route (same mechanism as every real
// browser upload) and traces the run to completion or to a clean stop.
// ============================================================

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL must all be set' }))
  process.exit(1)
}

const JOB_ID = '1f12de7f-47b5-442e-9581-1f813796eb70'
const TARGET_FILE_ID = 'f2b240fb-5be7-4931-b795-4d140c1c7e63'

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function main() {
  const runStartedAt = new Date().toISOString()

  // ── 0. Re-confirm pre-correction state (must match the earlier read-only check) ──
  const { data: preRow, error: preErr } = await supabase
    .from('files')
    .select('id, filename, intake_status, intake_stage, intake_pct, ai_failure_classification, ai_failure_count, failure_stage, failure_reason, processing_batch_id, created_at, builder_id, job_id')
    .eq('id', TARGET_FILE_ID)
    .maybeSingle()
  if (preErr || !preRow) {
    log('pre_state_lookup_failed', { error: preErr?.message ?? null, found: !!preRow })
    process.exit(1)
  }
  log('pre_correction_state', preRow)

  if (preRow.ai_failure_classification !== 'unknown' || preRow.ai_failure_count !== 1 || preRow.intake_status !== 'failed') {
    log('pre_state_unexpected_aborting', { message: 'State no longer matches the expected pre-correction snapshot — aborting rather than guessing.' })
    process.exit(1)
  }

  const { data: quoteRow } = await supabase.from('quotes').select('builder_id').eq('job_id', JOB_ID).limit(1).maybeSingle()
  const builderId = quoteRow?.builder_id
  if (!builderId) {
    log('builder_lookup_failed', { job_id: JOB_ID })
    process.exit(1)
  }

  // ── 1. THE ONE CORRECTION WRITE ──────────────────────────────────────────
  const { data: correctedRow, error: correctErr } = await supabase
    .from('files')
    .update({
      ai_failure_classification: 'truncated_response',
      // ai_failure_count intentionally left at 1 (unchanged, accurate).
      intake_status: 'uploaded',
      intake_stage: null,
      intake_pct: null,
      failure_stage: null,
      failure_reason: null,
    })
    .eq('id', TARGET_FILE_ID)
    .select('id, filename, intake_status, intake_stage, intake_pct, ai_failure_classification, ai_failure_count, failure_stage, failure_reason, processing_batch_id')
    .maybeSingle()
  if (correctErr || !correctedRow) {
    log('correction_write_failed', { error: correctErr?.message ?? null })
    process.exit(1)
  }
  log('correction_applied', correctedRow)

  // ── 2. Identify this file's real siblings (the same upload session, by created_at proximity) ──
  const { data: sameJobFiles } = await supabase
    .from('files')
    .select('id, filename, created_at')
    .eq('job_id', JOB_ID)
    .order('created_at', { ascending: true })
  const targetCreatedAt = new Date(preRow.created_at).getTime()
  const siblingIds = (sameJobFiles ?? [])
    .filter((f) => f.id !== TARGET_FILE_ID && Math.abs(new Date(f.created_at).getTime() - targetCreatedAt) <= 120_000)
    .map((f) => f.id)
  log('resolved_siblings', { target_created_at: preRow.created_at, sibling_count: siblingIds.length, sibling_ids: siblingIds })

  // ── 3. Baseline, read BEFORE retrigger, for later comparison ──
  const { data: baselineDocs } = await supabase.from('project_documents').select('id').eq('job_id', JOB_ID)
  const { data: baselineFacts } = await supabase.from('project_facts').select('id, superseded').eq('job_id', JOB_ID)
  const { data: baselineQuote } = await supabase.from('quotes').select('id, status, total_cost, overall_confidence, is_current, version, qa_report').eq('job_id', JOB_ID).eq('is_current', true).maybeSingle()
  log('baseline_state', {
    project_documents_count: baselineDocs?.length ?? 0,
    project_facts_total: baselineFacts?.length ?? 0,
    project_facts_active: (baselineFacts ?? []).filter((f) => !f.superseded).length,
    quote: baselineQuote ? { ...baselineQuote, qa_report: baselineQuote.qa_report ? '[present]' : null } : null,
  })

  // ── 4. Trigger the real pipeline via GET /api/intake/[fileId] ──
  const authHeaders = { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'x-worka-builder-id': builderId }
  const intakeUrl = `${APP_URL}/api/intake/${TARGET_FILE_ID}?job_id=${JOB_ID}&siblings=${siblingIds.join(',')}&started_at=${Date.now()}`
  log('triggering_intake', { url: intakeUrl })

  const sseController = new AbortController()
  const ssePromise = (async () => {
    try {
      const res = await fetch(intakeUrl, { headers: authHeaders, signal: sseController.signal })
      if (!res.ok || !res.body) {
        log('sse_connect_failed', { status: res.status, body: await res.text().catch(() => '') })
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const deadline = Date.now() + 6 * 60_000
      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          if (line.startsWith('data:')) log('sse_event', { data: line.slice(5).trim().slice(0, 1500) })
        }
      }
      reader.cancel().catch(() => {})
    } catch (err) {
      log('sse_stream_error', { error: err instanceof Error ? err.message : String(err) })
    }
  })()

  await sleep(5_000)

  // ── 5. Poll the DB directly for real evidence ──
  const POLL_INTERVAL_MS = 5_000
  const POLL_DEADLINE = Date.now() + 12 * 60_000
  let targetBatchId = null
  let lastSnapshot = null
  while (Date.now() < POLL_DEADLINE) {
    const { data: fileRow } = await supabase
      .from('files')
      .select('id, intake_status, intake_stage, intake_pct, ai_failure_classification, ai_failure_count, failure_stage, failure_reason, processing_batch_id')
      .eq('id', TARGET_FILE_ID)
      .single()

    if (fileRow?.processing_batch_id) targetBatchId = fileRow.processing_batch_id

    let batchRow = null
    let batchJobs = []
    if (targetBatchId) {
      const { data: b } = await supabase
        .from('document_processing_batches')
        .select('id, status, classification_triggered, quote_id, created_at, updated_at, stall_stage, stall_reason, stalled_at, stall_count, scope_reasoning_completed_at, stage6_completed_trade_ids')
        .eq('id', targetBatchId)
        .maybeSingle()
      batchRow = b
      const { data: jobs } = await supabase
        .from('document_processing_jobs')
        .select('id, document_id, status, attempts, last_error')
        .eq('parent_job_id', targetBatchId)
      batchJobs = jobs ?? []
    }

    const { data: newOps } = await supabase
      .from('ai_operations')
      .select('id, call_site, status, output_tokens, duration_ms, cost_cents, error_classification, error_message, created_at')
      .like('scope_key', `${JOB_ID}:%`)
      .gte('created_at', runStartedAt)
      .order('created_at', { ascending: true })

    const snapshot = JSON.stringify({ fileRow, batchRow, batchJobs, newOps })
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot
      log('poll_snapshot', { target_file: fileRow, target_batch: batchRow, batch_jobs: batchJobs, ai_operations_since_run_start: newOps })
    }

    if (fileRow?.intake_status && ['extracted', 'needs_info', 'failed'].includes(fileRow.intake_status)) {
      log('target_reached_terminal_status', { status: fileRow.intake_status })
      break
    }

    await sleep(POLL_INTERVAL_MS)
  }

  sseController.abort()
  await ssePromise.catch(() => {})

  // ── 6. Final state dump ──
  const { data: finalFile } = await supabase
    .from('files')
    .select('id, filename, intake_status, intake_stage, intake_pct, ai_failure_classification, ai_failure_count, failure_stage, failure_reason, processing_batch_id')
    .eq('id', TARGET_FILE_ID)
    .single()
  const { data: finalBatch } = finalFile?.processing_batch_id
    ? await supabase.from('document_processing_batches').select('*').eq('id', finalFile.processing_batch_id).maybeSingle()
    : { data: null }
  const { data: finalOps } = await supabase
    .from('ai_operations')
    .select('id, call_site, status, output_tokens, duration_ms, cost_cents, error_classification, error_message, created_at, result')
    .like('scope_key', `${JOB_ID}:%`)
    .gte('created_at', runStartedAt)
    .order('created_at', { ascending: true })
  // Strip the (possibly large) raw result down to just stop_reason for the log; full result stays queryable by id.
  const finalOpsSummary = (finalOps ?? []).map((o) => ({
    ...o,
    result: undefined,
    stop_reason: o.result && typeof o.result === 'object' ? (o.result.stop_reason ?? null) : null,
  }))
  const { data: finalDocs } = await supabase.from('project_documents').select('id, file_id, extraction_status, document_type, created_at').eq('job_id', JOB_ID)
  const { data: finalFacts } = await supabase.from('project_facts').select('id, superseded, source_document_id').eq('job_id', JOB_ID)
  const { data: finalQuote } = await supabase.from('quotes').select('id, status, total_cost, overall_confidence, is_current, version, qa_report').eq('job_id', JOB_ID).eq('is_current', true).maybeSingle()
  const { data: quoteLineItems } = finalQuote?.id
    ? await supabase.from('quote_line_items').select('id, total, rate, assumption_status').eq('quote_id', finalQuote.id)
    : { data: [] }
  // Matches diagnose-real-job-lifecycle.mjs's own consistency check exactly:
  // excluded items don't count toward the cached total.
  const recomputedTotal = (quoteLineItems ?? [])
    .filter((li) => li.assumption_status !== 'excluded')
    .reduce((sum, li) => sum + (li.total ?? 0), 0)
  // AiBudgetError (ai-gateway.ts) throws BEFORE any ai_operations row is
  // inserted, so a refusal never appears as an ai_operations row at all —
  // the real signal is files.ai_failure_classification === 'budget_refused'
  // (already captured on finalFile below), same value already observed on
  // several OTHER files in this job from an earlier circuit-breaker era.

  log('final_state', {
    target_file: finalFile,
    target_document_processing_batch: finalBatch,
    ai_operations_since_run_start: finalOpsSummary,
    project_documents_count: finalDocs?.length ?? 0,
    project_documents_for_target: (finalDocs ?? []).filter((d) => d.file_id === TARGET_FILE_ID),
    project_documents_all: finalDocs,
    project_facts_total: finalFacts?.length ?? 0,
    project_facts_active: (finalFacts ?? []).filter((f) => !f.superseded).length,
    project_facts_from_target_document: (finalFacts ?? []).filter((f) => finalDocs?.some((d) => d.file_id === TARGET_FILE_ID && d.id === f.source_document_id)).length,
    current_quote: finalQuote ? { ...finalQuote, qa_report: finalQuote.qa_report ? '[present — see quote_state separately]' : null } : null,
    quote_line_items_count: quoteLineItems?.length ?? 0,
    quote_total_cost_cached: finalQuote?.total_cost ?? null,
    quote_total_cost_recomputed_from_line_items: recomputedTotal,
    quote_totals_consistent: finalQuote?.total_cost != null && Math.abs((finalQuote.total_cost ?? 0) - recomputedTotal) < 0.01,
    target_file_ai_failure_classification_final: finalFile?.ai_failure_classification ?? null,
    baseline_project_documents_count: baselineDocs?.length ?? 0,
    baseline_project_facts_total: baselineFacts?.length ?? 0,
    baseline_quote_total_cost: baselineQuote?.total_cost ?? null,
  })

  log('done', { job_id: JOB_ID, target_file_id: TARGET_FILE_ID, target_batch_id: targetBatchId })
}

main().catch((err) => {
  console.log(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
