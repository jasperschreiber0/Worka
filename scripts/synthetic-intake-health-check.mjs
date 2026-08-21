#!/usr/bin/env node
// ============================================================
// WorkA — synthetic document-intake pipeline health check
// ============================================================
// Automates the manual runbook's end-to-end smoke test: upload -> intake
// batch/job creation -> document-worker claim -> extraction -> classification
// trigger -> (best-effort) full reasoning pipeline completion, against the
// REAL deployed Supabase project and edge functions — the one part of the
// pipeline nothing in this repo's own CI or unit tests can exercise, since
// it requires a live document-worker/smooth-responder invocation.
//
// Deliberately NOT run on every deploy: it invokes real edge functions and,
// once classification triggers, real Claude API calls (cost + latency) —
// see .github/workflows/intake-pipeline-health-check.yml for the schedule
// this is meant to run on instead (e.g. every few hours), independent of
// the deploy cadence.
//
// What PASS actually certifies:
//   1. A file can be uploaded to Storage and inserted into `files`.
//   2. document_processing_batches/jobs rows can be created and claimed.
//   3. document-worker claims the job, downloads it, extracts it, and marks
//      it terminal (completed or failed) via the real RPCs.
//   4. The batch aggregate status derivation + exactly-once
//      classification_triggered flip fires as designed.
//   5. smooth-responder is reachable and reacts to the trigger — the primary
//      file's intake_status leaves 'processing' for a recognized terminal
//      value (extracted / needs_info / failed).
//
// What PASS does NOT certify: extraction/reasoning *accuracy*. The synthetic
// PDF carries a couple of plausible sentences so Stage 1/2 has something
// real to extract, but this is a plumbing check, not a content-quality eval
// — a `needs_info` outcome (the engine correctly recognizing this synthetic
// document is too sparse and pausing for clarification) is treated as a pass
// for that reason, not papered over as a failure.
//
// Cleanup: every row/object this script creates is deleted in a `finally`
// block regardless of outcome, so a failed or interrupted run doesn't leave
// synthetic data behind. Uses a fresh random job id every run specifically
// so concurrent/overlapping runs (or a previous run's failed cleanup) can
// never collide.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
// Optional: when set, a detected wall-clock stall directly invokes the real
// GET /api/cron/intake-recovery route once (see the poll loop below) instead
// of only waiting on the external cron to fire before this script's own
// deadline. Absent = old behavior (observe only).
const RECOVERY_APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
const RECOVERY_CRON_SECRET = process.env.CRON_SECRET

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error(JSON.stringify({ event: 'health_check_config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and NEXT_PUBLIC_SUPABASE_ANON_KEY must all be set' }))
  process.exit(1)
}

// Reserved, clearly-namespaced builder id — never a real signup, service
// role bypasses RLS so no auth.users row is needed for it to work.
const BUILDER_ID = '00000000-0000-0000-0000-0000000000fe'

const EXTRACTION_TIMEOUT_MS = 90_000
// Widened from 240_000: files.intake_status only reaches 'extracted' AFTER
// the full pipeline (Stage 1/2 classification through Stage 6 Estimate
// Generation + quote build — see index.ts's own comment on
// recompute_batch_file_intake_statuses, migration 052), not just
// classification. Stage 3 (up to 220s) + Stage 6 (up to 220s,
// STAGE6_PER_CALL_TIMEOUT_MS) can exceed one invocation's wall-clock budget
// on a real project, in which case the recovery cron (runs ~every minute)
// resumes it — this budget leaves room for that resume rather than only a
// single invocation's worth of time.
const CLASSIFICATION_TIMEOUT_MS = 480_000
const POLL_INTERVAL_MS = 3_000

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Builds a minimal, byte-accurate (correct xref offsets) single-page PDF
// with a real text stream, so Stage 1/2 has genuine evidence to extract
// rather than an empty or malformed document that would only test the
// engine's error path instead of its normal one.
function buildSyntheticPdf() {
  const text = [
    'BT /F1 18 Tf 72 720 Td (WorkA synthetic health-check document.) Tj',
    '0 -24 Td (Single storey renovation, 100m2 floor area, VIC.) Tj',
    '0 -24 Td (Scope: kitchen renovation only. No structural work.) Tj ET',
  ].join('\n')

  const objects = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] = '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>'
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  objects[5] = `<< /Length ${Buffer.byteLength(text, 'utf8')} >>\nstream\n${text}\nendstream`

  let body = '%PDF-1.4\n'
  const offsets = [0] // object 0 is the free-list head, never written directly
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(body, 'utf8')
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }

  const xrefOffset = Buffer.byteLength(body, 'utf8')
  let xref = `xref\n0 6\n0000000000 65535 f \n`
  for (let i = 1; i <= 5; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`

  return Buffer.from(body + xref + trailer, 'utf8')
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const jobId = crypto.randomUUID()
  const runTag = new Date().toISOString()
  const storagePath = `health-check/${jobId}/synthetic.pdf`

  const result = {
    passed: false,
    job_id: jobId,
    steps: {},
  }

  try {
    log('health_check_started', { job_id: jobId })

    // ── 0. Read-only preflight: dump the AI gateway's budget-gate state
    //      (migration 054) before doing anything else. A prior run failed
    //      with ai_failure_classification: 'budget_refused' inside
    //      smooth-responder, but that classification alone doesn't say
    //      WHICH of the gateway's three fail-closed branches fired (breaker
    //      state unreadable / breaker tripped / daily spend limit reached —
    //      see decideBudget in supabase/functions/smooth-responder/
    //      ai-gateway.ts). Logging the actual rows here answers that
    //      directly instead of guessing from the classification alone.
    const { data: statusRows, error: statusErr } = await supabase
      .from('system_status')
      .select('key, value')
      .in('key', ['ai_circuit_breaker', 'ai_limits'])
    const { data: spendRows, error: spendErr } = await supabase
      .from('ai_spend_daily')
      .select('builder_id, cost_cents')
      .eq('day', new Date().toISOString().slice(0, 10))
    log('health_check_budget_gate_preflight', {
      job_id: jobId,
      status_rows: statusRows ?? null,
      status_error: statusErr?.message ?? null,
      today_spend_rows: spendRows ?? null,
      spend_error: spendErr?.message ?? null,
    })

    // ── 1. Builder + job (upload target) ──────────────────────────────
    await supabase.from('builders').upsert(
      { id: BUILDER_ID, email: 'health-check@getworka.com', name: 'Synthetic Health Check' },
      { onConflict: 'id', ignoreDuplicates: true }
    )

    const { error: jobErr } = await supabase.from('jobs').insert({
      id: jobId,
      builder_id: BUILDER_ID,
      address: `HEALTH CHECK — synthetic, safe to delete (${runTag})`,
      status: 'quoting',
      job_type: 'health_check',
    })
    if (jobErr) throw new Error(`job insert failed: ${jobErr.message}`)
    result.steps.job_created = true

    // ── 2. Upload synthetic PDF ─────────────────────────────────────────
    const pdfBuffer = buildSyntheticPdf()
    const { error: uploadErr } = await supabase.storage
      .from('plans')
      .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true })
    if (uploadErr) throw new Error(`storage upload failed: ${uploadErr.message}`)
    result.steps.uploaded = true

    const { data: fileRow, error: fileErr } = await supabase
      .from('files')
      .insert({
        job_id: jobId,
        builder_id: BUILDER_ID,
        storage_path: storagePath,
        filename: 'synthetic.pdf',
        file_type: 'pdf',
        intake_status: 'uploaded',
      })
      .select()
      .single()
    if (fileErr || !fileRow) throw new Error(`files insert failed: ${fileErr?.message ?? 'no row returned'}`)
    result.steps.file_row_created = true
    log('health_check_uploaded', { job_id: jobId, file_id: fileRow.id })

    // ── 3. Document processing batch + job (mirrors createDocumentProcessingBatch
    //      in app/api/intake/[fileId]/route.ts) ─────────────────────────
    const { data: batchRow, error: batchErr } = await supabase
      .from('document_processing_batches')
      .insert({ job_id: jobId, builder_id: BUILDER_ID, primary_file_id: fileRow.id, status: 'running' })
      .select()
      .single()
    if (batchErr || !batchRow) throw new Error(`batch insert failed: ${batchErr?.message ?? 'no row returned'}`)

    const { error: jobsInsertErr } = await supabase
      .from('document_processing_jobs')
      .insert({ parent_job_id: batchRow.id, document_id: fileRow.id })
    if (jobsInsertErr) throw new Error(`document_processing_jobs insert failed: ${jobsInsertErr.message}`)

    await supabase.from('files').update({ processing_batch_id: batchRow.id, intake_status: 'processing' }).eq('id', fileRow.id)
    result.steps.batch_created = true
    log('health_check_batch_created', { job_id: jobId, batch_id: batchRow.id })

    // ── 4. Trigger document-worker (same call shape as the real route) ──
    const workerRes = await fetch(`${SUPABASE_URL}/functions/v1/document-worker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}` },
      body: JSON.stringify({ parent_job_id: batchRow.id, builder_id: BUILDER_ID }),
    })
    if (!workerRes.ok) throw new Error(`document-worker invocation failed: HTTP ${workerRes.status} ${await workerRes.text().catch(() => '')}`)
    result.steps.worker_invoked = true
    log('health_check_worker_invoked', { job_id: jobId, batch_id: batchRow.id, status: workerRes.status })

    // ── 5. Poll for extraction to reach a terminal state ────────────────
    const extractionDeadline = Date.now() + EXTRACTION_TIMEOUT_MS
    let extractionTerminal = null
    while (Date.now() < extractionDeadline) {
      const { data: jobs } = await supabase
        .from('document_processing_jobs')
        .select('status, error_message, attempts')
        .eq('parent_job_id', batchRow.id)
      const row = jobs?.[0]
      if (row && (row.status === 'completed' || row.status === 'failed')) {
        extractionTerminal = row
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }
    if (!extractionTerminal) {
      throw new Error(`extraction did not reach a terminal state within ${EXTRACTION_TIMEOUT_MS}ms — document_processing_jobs likely stuck at 'running' or 'pending' (this is exactly the stuck-job gap migration 036's reclaim_stale_document_jobs exists to recover from on the NEXT claim attempt against this batch, not within this run's own timeout)`)
    }
    result.steps.extraction = extractionTerminal.status
    log('health_check_extraction_terminal', { job_id: jobId, status: extractionTerminal.status, attempts: extractionTerminal.attempts })
    if (extractionTerminal.status === 'failed') {
      throw new Error(`document extraction permanently failed: ${extractionTerminal.error_message}`)
    }

    // ── 6. Poll for the batch to become terminal + classification_triggered ──
    let batchTerminal = null
    const batchDeadline = Date.now() + EXTRACTION_TIMEOUT_MS
    while (Date.now() < batchDeadline) {
      const { data: b } = await supabase
        .from('document_processing_batches')
        .select('status, classification_triggered')
        .eq('id', batchRow.id)
        .single()
      if (b && b.status !== 'pending' && b.status !== 'running') {
        batchTerminal = b
        break
      }
      await sleep(POLL_INTERVAL_MS)
    }
    if (!batchTerminal) throw new Error('document_processing_batches never left running/pending — recompute_parent_batch_status may not be firing')
    if (!batchTerminal.classification_triggered) throw new Error('batch reached a terminal status but classification_triggered was never flipped true')
    result.steps.batch_status = batchTerminal.status
    result.steps.classification_triggered = true
    log('health_check_batch_terminal', { job_id: jobId, status: batchTerminal.status })

    // ── 7. Best-effort: wait for smooth-responder's classification/reasoning
    //      stages to leave the primary file in a recognized terminal state.
    //      Not a hard requirement for PASS beyond "reachable and progressing"
    //      — see header comment on why content-level accuracy isn't judged here.
    //      Also polls document_processing_batches' diagnostic columns
    //      (stall_stage/stall_reason, stage6_failure_*, ai_failure_*) and logs
    //      any CHANGE in them — this is the only visibility into WHY a run
    //      doesn't converge, since cleanup below deletes the batch/file rows
    //      unconditionally and this script's own DB access is the only path
    //      available to inspect them (direct DB access from a normal dev
    //      session is not always available).
    let finalIntakeStatus = null
    let lastDiagnosticSnapshot = null
    let recoveryTriggered = false
    const classificationDeadline = Date.now() + CLASSIFICATION_TIMEOUT_MS
    while (Date.now() < classificationDeadline) {
      const { data: f } = await supabase.from('files').select('intake_status, intake_stage, intake_pct, ai_failure_classification, ai_failure_count, failure_stage, failure_reason').eq('id', fileRow.id).single()
      const { data: b } = await supabase
        .from('document_processing_batches')
        .select('status, stall_stage, stall_reason, stalled_at, stall_count, scope_reasoning_completed_at, stage6_failure_classification, stage6_failure_count, quote_id')
        .eq('id', batchRow.id)
        .single()
      const snapshot = JSON.stringify({ f, b })
      if (snapshot !== lastDiagnosticSnapshot) {
        lastDiagnosticSnapshot = snapshot
        log('health_check_diagnostic_snapshot', { job_id: jobId, batch_id: batchRow.id, file: f, batch: b })
      }
      if (f && ['extracted', 'needs_info', 'failed'].includes(f.intake_status)) {
        finalIntakeStatus = f.intake_status
        break
      }
      // ── Diagnostic-only: a wall-clock stall (bailForWallClockBudget) is a
      //    normal, designed-for outcome that's supposed to self-heal via the
      //    recovery cron (GET /api/cron/intake-recovery, ~1-5 min cadence).
      //    Calling it directly here, once, the moment a stall is observed,
      //    tests whether that resume path actually works end-to-end in ONE
      //    run rather than hoping an external cron fires before this script's
      //    own deadline (and before cleanup deletes the evidence). Same route,
      //    same auth, same idempotent RPCs the real cron uses — not a new
      //    recovery mechanism, just calling the existing one directly.
      if (!recoveryTriggered && b?.stall_stage && RECOVERY_APP_URL && RECOVERY_CRON_SECRET) {
        recoveryTriggered = true
        try {
          const recRes = await fetch(`${RECOVERY_APP_URL.replace(/\/$/, '')}/api/cron/intake-recovery`, {
            headers: { Authorization: `Bearer ${RECOVERY_CRON_SECRET}` },
          })
          const recBody = await recRes.text().catch(() => '')
          log('health_check_recovery_triggered', { job_id: jobId, batch_id: batchRow.id, http_status: recRes.status, body: recBody.slice(0, 2000) })
        } catch (recErr) {
          log('health_check_recovery_trigger_failed', { job_id: jobId, batch_id: batchRow.id, error: recErr instanceof Error ? recErr.message : String(recErr) })
        }
      }
      await sleep(POLL_INTERVAL_MS)
    }
    result.steps.final_intake_status = finalIntakeStatus ?? 'timed_out_still_processing'
    log('health_check_classification_result', { job_id: jobId, final_intake_status: result.steps.final_intake_status })

    // ── 8. If the pipeline reached 'extracted', verify the actual quote it
    //      produced, not just that classification finished — this is what
    //      distinguishes "the pipeline is reachable" (what this script has
    //      always certified) from "a builder gets a usable estimate" (what
    //      this run adds, read-only, ahead of cleanup deleting everything).
    if (finalIntakeStatus === 'extracted') {
      const { data: quoteRow } = await supabase
        .from('quotes')
        .select('id, status, total_cost, margin_pct, overall_confidence, qa_report')
        .eq('job_id', jobId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!quoteRow) {
        result.steps.quote_verified = false
        log('health_check_quote_missing', { job_id: jobId, reason: 'intake_status reached extracted but no quotes row exists for this job' })
      } else {
        const { data: lineItems } = await supabase
          .from('quote_line_items')
          .select('id, trade_category_id, rate, total, margin_pct, pricing_type')
          .eq('quote_id', quoteRow.id)

        const items = lineItems ?? []
        const pricedItems = items.filter((i) => i.rate !== null || i.pricing_type === 'provisional_sum')
        const tradeCategoriesCovered = new Set(items.map((i) => i.trade_category_id)).size
        const clientPrice = items.reduce((sum, i) => {
          if (i.total === null) return sum
          const marginFraction = i.margin_pct ?? 0
          return sum + i.total * (1 + marginFraction)
        }, 0)

        result.steps.quote_verified = true
        result.quote = {
          quote_id: quoteRow.id,
          status: quoteRow.status,
          total_cost: quoteRow.total_cost,
          margin_pct: quoteRow.margin_pct,
          overall_confidence: quoteRow.overall_confidence,
          has_qa_report: quoteRow.qa_report !== null,
          line_item_count: items.length,
          priced_line_item_count: pricedItems.length,
          trade_categories_covered: tradeCategoriesCovered,
          computed_client_price_ex_gst: Math.round(clientPrice * 100) / 100,
        }
        log('health_check_quote_verified', { job_id: jobId, ...result.quote })
      }
    } else {
      result.steps.quote_verified = false
      log('health_check_quote_skipped', { job_id: jobId, reason: `final_intake_status was '${result.steps.final_intake_status}', not 'extracted'` })
    }

    result.passed = true
    log('health_check_passed', result)
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    log('health_check_failed', result)
  } finally {
    // ── Cleanup: delete files first (no ON DELETE CASCADE from jobs to
    // files — see migration 001), then the job row (cascades quotes,
    // document_processing_batches -> document_processing_jobs,
    // project_documents/facts/scope_items/clarifying_questions,
    // job_intake_locks, job_tasks, job_workers, milestones/invoices). ──
    try {
      await supabase.from('files').delete().eq('job_id', jobId)
      await supabase.from('jobs').delete().eq('id', jobId)
      await supabase.storage.from('plans').remove([storagePath])
      log('health_check_cleanup_complete', { job_id: jobId })
    } catch (cleanupErr) {
      log('health_check_cleanup_failed', { job_id: jobId, error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) })
    }
  }

  process.exit(result.passed ? 0 : 1)
}

main()
