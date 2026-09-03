#!/usr/bin/env node
// ============================================================
// WorkA — document processing queue reliability check
// ============================================================
// Exercises the document_processing_jobs/batches queue primitives
// (migrations 034, 036, 037) directly against the REAL deployed Supabase
// project's RPCs — the guarantees the queue model depends on, isolated
// from extraction/reasoning accuracy (that end-to-end path is what
// scripts/synthetic-intake-health-check.mjs already certifies). This
// script never invokes document-worker or smooth-responder and makes no
// Claude API calls, so unlike that script it's cheap enough to run on
// every push that touches this subsystem, not just on a schedule.
//
// Root cause this guards against: an incident where a document batch got
// stuck at 4 of 7 documents processed because the pipeline's only
// continuation mechanism (document-worker's fire-and-forget triggerNext())
// silently failed, and the only backstop (the recovery cron) depended on
// an external scheduler (GitHub Actions) that was found to be firing
// roughly once an hour instead of every 5 minutes. Migration 038 fixes the
// scheduler; this script proves the underlying queue primitives that
// scheduler depends on actually hold under concurrency and partial
// failure, independent of any scheduler at all.
//
// Five scenarios, matching the production requirements this was built for:
//   1. Worker completes but the next trigger is never fired (simulates a
//      lost triggerNext() call) -> the batch's remaining pending work is
//      still discoverable via find_batches_with_claimable_work(), and
//      completing it manually (what the independent poller would do)
//      still drives the batch to a correct terminal state.
//   2. A job stuck at status='running' past the staleness window (a
//      simulated CPU-kill mid-extraction) becomes retryable again via
//      reclaim_stale_document_jobs(), with attempts incremented.
//   3. Two concurrent claim_next_document_job() calls against a single
//      pending job -> exactly one succeeds, the other gets nothing (FOR
//      UPDATE SKIP LOCKED).
//   4. A reclaimed stale job can be claimed and completed again — recovery
//      doesn't just mark it retryable, the retried attempt actually goes
//      on to succeed.
//   5. One document permanently failing (3 exhausted attempts) does not
//      fail the batch or block its siblings — recompute_parent_batch_status
//      returns 'completed_with_failures', not 'failed'.
//
// Cleanup: every row this script creates is deleted in a `finally` block
// regardless of outcome. Uses a fresh random job id every run so
// concurrent/overlapping runs never collide.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(JSON.stringify({ event: 'queue_check_config_error', message: 'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set' }))
  process.exit(1)
}

// Reserved, clearly-namespaced builder id — distinct from
// synthetic-intake-health-check.mjs's own reserved id so the two scripts
// can never collide if run concurrently.
const BUILDER_ID = '00000000-0000-0000-0000-0000000000fd'

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

async function makeJobAndFiles(supabase, jobId, filenames) {
  const { error: jobErr } = await supabase.from('jobs').insert({
    id: jobId,
    builder_id: BUILDER_ID,
    address: `QUEUE CHECK — synthetic, safe to delete (${new Date().toISOString()})`,
    status: 'quoting',
    job_type: 'health_check',
  })
  if (jobErr) throw new Error(`job insert failed: ${jobErr.message}`)

  const { data: fileRows, error: fileErr } = await supabase
    .from('files')
    .insert(filenames.map((filename) => ({
      job_id: jobId,
      builder_id: BUILDER_ID,
      // Never actually downloaded — every scenario here drives
      // document_processing_jobs directly via RPC, not through
      // document-worker, so no real storage object is needed.
      storage_path: `queue-check/${jobId}/${filename}`,
      filename,
      file_type: 'pdf',
      intake_status: 'uploaded',
    })))
    .select()
  if (fileErr || !fileRows) throw new Error(`files insert failed: ${fileErr?.message ?? 'no rows returned'}`)
  return fileRows
}

async function makeBatch(supabase, jobId, primaryFileId, fileIds) {
  const { data: batchRow, error: batchErr } = await supabase
    .from('document_processing_batches')
    .insert({ job_id: jobId, builder_id: BUILDER_ID, primary_file_id: primaryFileId, status: 'running' })
    .select()
    .single()
  if (batchErr || !batchRow) throw new Error(`batch insert failed: ${batchErr?.message ?? 'no row returned'}`)

  const { data: jobRows, error: jobsErr } = await supabase
    .from('document_processing_jobs')
    .insert(fileIds.map((documentId) => ({ parent_job_id: batchRow.id, document_id: documentId })))
    .select()
  if (jobsErr || !jobRows) throw new Error(`document_processing_jobs insert failed: ${jobsErr?.message ?? 'no rows returned'}`)

  return { batchRow, jobRows }
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const results = { passed: false, scenarios: {} }
  const createdJobIds = []

  try {
    await supabase.from('builders').upsert(
      { id: BUILDER_ID, email: 'queue-check@getworka.com', name: 'Synthetic Queue Check' },
      { onConflict: 'id', ignoreDuplicates: true }
    )

    // ── Scenario 3: two workers cannot claim the same job ─────────────────
    {
      const jobId = crypto.randomUUID()
      createdJobIds.push(jobId)
      const [file] = await makeJobAndFiles(supabase, jobId, ['single.pdf'])
      const { batchRow } = await makeBatch(supabase, jobId, file.id, [file.id])

      const [a, b] = await Promise.all([
        supabase.rpc('claim_next_document_job', { p_parent_job_id: batchRow.id, p_worker_id: 'queue-check-a' }),
        supabase.rpc('claim_next_document_job', { p_parent_job_id: batchRow.id, p_worker_id: 'queue-check-b' }),
      ])
      if (a.error) throw new Error(`claim A failed: ${a.error.message}`)
      if (b.error) throw new Error(`claim B failed: ${b.error.message}`)
      const claimedCount = (a.data?.length ?? 0) + (b.data?.length ?? 0)
      assert(claimedCount === 1, `exactly one of two concurrent claims should succeed, got ${claimedCount}`)
      results.scenarios.concurrent_claim_exclusive = true
      log('scenario_passed', { scenario: 'concurrent_claim_exclusive', claimed_count: claimedCount })
    }

    // ── Scenario 2 & 4: stale 'running' job is reclaimed, then successfully
    //    retried (recovery doesn't just mark it retryable — it resumes) ────
    {
      const jobId = crypto.randomUUID()
      createdJobIds.push(jobId)
      const [file] = await makeJobAndFiles(supabase, jobId, ['stale.pdf'])
      const { batchRow, jobRows } = await makeBatch(supabase, jobId, file.id, [file.id])
      const jobRowId = jobRows[0].id

      // Simulate a worker that claimed this job and was then CPU-killed
      // mid-extraction: status='running', locked_at far enough in the past
      // to be past the 3-minute staleness window.
      const staleLockedAt = new Date(Date.now() - 5 * 60_000).toISOString()
      const { error: staleErr } = await supabase
        .from('document_processing_jobs')
        .update({ status: 'running', locked_at: staleLockedAt, started_at: staleLockedAt, locked_by: 'dead-worker' })
        .eq('id', jobRowId)
      if (staleErr) throw new Error(`failed to simulate stale running job: ${staleErr.message}`)

      const { data: reclaimed, error: reclaimErr } = await supabase.rpc('reclaim_stale_document_jobs', {
        p_stale_after: '3 minutes',
        p_parent_job_id: batchRow.id,
      })
      if (reclaimErr) throw new Error(`reclaim_stale_document_jobs failed: ${reclaimErr.message}`)
      assert(reclaimed?.length === 1, `expected exactly one job reclaimed, got ${reclaimed?.length ?? 0}`)

      const { data: afterReclaim, error: afterErr } = await supabase
        .from('document_processing_jobs')
        .select('status, attempts, run_after')
        .eq('id', jobRowId)
        .single()
      if (afterErr || !afterReclaim) throw new Error(`failed to re-read reclaimed job: ${afterErr?.message}`)
      assert(afterReclaim.status === 'pending', `reclaimed job should be 'pending', got '${afterReclaim.status}'`)
      assert(afterReclaim.attempts === 1, `reclaimed job should have attempts=1, got ${afterReclaim.attempts}`)
      results.scenarios.stale_job_reclaimed = true
      log('scenario_passed', { scenario: 'stale_job_reclaimed', job_id: jobRowId })

      // Scenario 4: the reclaimed job must actually be resumable, not just
      // theoretically retryable — clear the backoff delay (we're not
      // testing the 30s wait itself, only that recovery leads to a real
      // second attempt succeeding) and drive it through claim + complete.
      await supabase.from('document_processing_jobs').update({ run_after: new Date().toISOString() }).eq('id', jobRowId)

      const { data: reclaimedClaim, error: reclaimClaimErr } = await supabase.rpc('claim_next_document_job', {
        p_parent_job_id: batchRow.id, p_worker_id: 'queue-check-retry',
      })
      if (reclaimClaimErr) throw new Error(`claim after reclaim failed: ${reclaimClaimErr.message}`)
      assert(reclaimedClaim?.length === 1, 'reclaimed job should be claimable on the next attempt')

      const { error: completeErr } = await supabase.rpc('complete_document_job', {
        p_job_id: jobRowId, p_result: { blockType: 'text_only', text: 'ok', hasUsableText: true, pageCount: 1, durationMs: 10 },
      })
      if (completeErr) throw new Error(`complete_document_job after reclaim failed: ${completeErr.message}`)

      const { data: finalRow } = await supabase.from('document_processing_jobs').select('status').eq('id', jobRowId).single()
      assert(finalRow?.status === 'completed', `job should complete successfully on its retried attempt, got '${finalRow?.status}'`)
      results.scenarios.reclaimed_job_resumes_successfully = true
      log('scenario_passed', { scenario: 'reclaimed_job_resumes_successfully', job_id: jobRowId })
    }

    // ── Scenario 1: worker completes but the next trigger is never fired —
    //    the batch's remaining work must still be independently discoverable
    //    (this is exactly what pg_cron's 1-minute poll, migration 038,
    //    relies on instead of trusting document-worker's fire-and-forget
    //    triggerNext) ───────────────────────────────────────────────────────
    {
      const jobId = crypto.randomUUID()
      createdJobIds.push(jobId)
      const files = await makeJobAndFiles(supabase, jobId, ['first.pdf', 'second.pdf'])
      const { batchRow, jobRows } = await makeBatch(supabase, jobId, files[0].id, files.map((f) => f.id))

      // Complete the first job WITHOUT ever calling triggerNext — this is
      // the exact failure this scenario simulates: a worker finished but
      // the fire-and-forget call to continue the chain was lost.
      const { data: claim1 } = await supabase.rpc('claim_next_document_job', { p_parent_job_id: batchRow.id, p_worker_id: 'queue-check-1' })
      assert(claim1?.length === 1, 'first claim should succeed')
      await supabase.rpc('complete_document_job', {
        p_job_id: claim1[0].id, p_result: { blockType: 'text_only', text: 'ok', hasUsableText: true, pageCount: 1, durationMs: 10 },
      })

      // Nothing has re-triggered document-worker for the second job. Prove
      // it's still independently discoverable — this is what makes the
      // pipeline's forward progress NOT depend on triggerNext succeeding.
      const { data: claimable, error: claimableErr } = await supabase.rpc('find_batches_with_claimable_work')
      if (claimableErr) throw new Error(`find_batches_with_claimable_work failed: ${claimableErr.message}`)
      const found = (claimable ?? []).find((b) => b.parent_job_id === batchRow.id)
      assert(found != null, 'batch with one remaining pending job should be discoverable via find_batches_with_claimable_work')
      assert(Number(found.pending_count) === 1, `expected pending_count=1, got ${found.pending_count}`)
      results.scenarios.lost_trigger_still_discoverable = true
      log('scenario_passed', { scenario: 'lost_trigger_still_discoverable', batch_id: batchRow.id })

      // Simulate what the independent poller (pg_cron -> recovery route ->
      // fresh document-worker invocation) does next: claim and complete
      // the remaining job, and confirm the batch reaches a correct
      // terminal state with classification triggered exactly once.
      const { data: claim2 } = await supabase.rpc('claim_next_document_job', { p_parent_job_id: batchRow.id, p_worker_id: 'queue-check-2' })
      assert(claim2?.length === 1, 'second claim should succeed once independently resumed')
      const { data: completeResult } = await supabase.rpc('complete_document_job', {
        p_job_id: claim2[0].id, p_result: { blockType: 'text_only', text: 'ok', hasUsableText: true, pageCount: 1, durationMs: 10 },
      })
      assert(completeResult?.[0]?.new_status === 'completed', `batch should reach 'completed', got '${completeResult?.[0]?.new_status}'`)
      assert(completeResult?.[0]?.should_trigger_classification === true, 'classification should be triggered exactly once on final completion')
      results.scenarios.batch_completes_after_independent_resume = true
      log('scenario_passed', { scenario: 'batch_completes_after_independent_resume', batch_id: batchRow.id })
    }

    // ── Scenario 5: one permanently-failed document does not fail the
    //    batch or block its siblings ───────────────────────────────────────
    {
      const jobId = crypto.randomUUID()
      createdJobIds.push(jobId)
      const files = await makeJobAndFiles(supabase, jobId, ['good1.pdf', 'corrupted.pdf', 'good2.pdf'])
      const { batchRow, jobRows } = await makeBatch(supabase, jobId, files[0].id, files.map((f) => f.id))
      const corruptedJobId = jobRows.find((j) => j.document_id === files[1].id).id
      const goodJobIds = jobRows.filter((j) => j.document_id !== files[1].id).map((j) => j.id)

      // Exhaust all 3 attempts on the "corrupted" document directly via the
      // RPC — this is the same terminal state a real pdf.js crash-loop
      // reaches (see document-worker's retry safeguard comment), reached
      // here without waiting out the real 30s/2min backoff delays.
      let lastResult = null
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { data, error } = await supabase.rpc('retry_or_fail_document_job', {
          p_job_id: corruptedJobId, p_error: 'simulated: pdf.js CPU-kill mid-parse', p_max_attempts: 3,
        })
        if (error) throw new Error(`retry_or_fail_document_job attempt ${attempt} failed: ${error.message}`)
        lastResult = data?.[0]
      }
      const { data: corruptedRow } = await supabase.from('document_processing_jobs').select('status, attempts').eq('id', corruptedJobId).single()
      assert(corruptedRow?.status === 'failed', `corrupted document should be permanently failed after 3 attempts, got '${corruptedRow?.status}'`)
      assert(corruptedRow?.attempts === 3, `expected attempts=3, got ${corruptedRow?.attempts}`)

      // Siblings must be completely unaffected by the corrupted document's
      // failure — complete them normally.
      for (const goodJobId of goodJobIds) {
        const { data: claimed } = await supabase.rpc('claim_next_document_job', { p_parent_job_id: batchRow.id, p_worker_id: `queue-check-good-${goodJobId}` })
        assert(claimed?.length === 1, `sibling document ${goodJobId} should still be independently claimable`)
        await supabase.rpc('complete_document_job', {
          p_job_id: goodJobId, p_result: { blockType: 'text_only', text: 'ok', hasUsableText: true, pageCount: 1, durationMs: 10 },
        })
      }

      const { data: finalBatch } = await supabase.from('document_processing_batches').select('status, classification_triggered').eq('id', batchRow.id).single()
      assert(finalBatch?.status === 'completed_with_failures', `batch with 2 completed + 1 permanently failed should be 'completed_with_failures', got '${finalBatch?.status}'`)
      assert(finalBatch?.classification_triggered === true, 'classification should still trigger once the batch is terminal, even with a failed sibling')
      results.scenarios.corrupted_document_does_not_block_siblings = true
      log('scenario_passed', { scenario: 'corrupted_document_does_not_block_siblings', batch_id: batchRow.id })
    }

    // ── Scenario 6: derive_estimate_run_projection reports 'complete' as
    //    soon as Stage 6 has produced a quote — regardless of an open
    //    blocking clarifying question or the quote still sitting in 'draft'
    //    (migration 080). Root cause this guards against: smooth-responder
    //    always proceeds past a blocking clarifying question with a
    //    disclosed conservative assumption (Stage 6 never actually waits on
    //    one), and every freshly generated quote starts in 'draft' — but
    //    derive_estimate_run_projection previously required BOTH
    //    blocking_open = 0 AND quote.status <> 'draft' before reporting
    //    'complete', which no real freshly-generated estimate could ever
    //    satisfy. Confirmed live: a real project's estimate_runs row stayed
    //    at 'awaiting_clarification' with builder_status permanently NULL
    //    despite Stage 6 having already produced a fully priced quote. ─────
    {
      const jobId = crypto.randomUUID()
      createdJobIds.push(jobId)
      const [file] = await makeJobAndFiles(supabase, jobId, ['scope.pdf'])
      const { batchRow } = await makeBatch(supabase, jobId, file.id, [file.id])

      const { data: quoteRow, error: quoteErr } = await supabase
        .from('quotes')
        .insert({ job_id: jobId, builder_id: BUILDER_ID, status: 'draft' })
        .select()
        .single()
      if (quoteErr || !quoteRow) throw new Error(`quote insert failed: ${quoteErr?.message ?? 'no row returned'}`)

      await supabase.from('document_processing_batches').update({ quote_id: quoteRow.id }).eq('id', batchRow.id)

      const { error: cqErr } = await supabase.from('clarifying_questions').insert({
        job_id: jobId,
        question: 'Is asbestos testing completed for the existing tiles?',
        reason: 'Pre-1990s renovations may disturb asbestos-containing materials.',
        blocking: true,
        status: 'open',
      })
      if (cqErr) throw new Error(`clarifying_questions insert failed: ${cqErr.message}`)

      const { data: proj, error: projErr } = await supabase.rpc('derive_estimate_run_projection', { p_batch_id: batchRow.id })
      if (projErr) throw new Error(`derive_estimate_run_projection failed: ${projErr.message}`)
      const status = Array.isArray(proj) ? proj[0]?.status : proj?.status
      assert(status === 'complete', `a batch with a quote should project 'complete' even with an open blocking question and a draft quote, got '${status}'`)
      results.scenarios.complete_status_ignores_blocking_question_and_draft_quote = true
      log('scenario_passed', { scenario: 'complete_status_ignores_blocking_question_and_draft_quote', batch_id: batchRow.id })
    }

    // ── Scenario 7: a batch whose document has a recorded Stage 1/2 AI
    //    failure (files.ai_failure_count > 0) must never be picked up by
    //    find_stuck_batches_needing_classification_retry again — this is
    //    the fix for the 60ea9c63-96ba-40b5-be2c-37c01fb33f01 incident
    //    (migration 088): Stage 3/6 both have a batch-level failure counter
    //    this query already excludes on, but Stage 1/2's failure signal
    //    (files.ai_failure_count, migration 042/043) lived on `files`,
    //    which this query never joined -- so a batch that failed during
    //    classification (before ever reaching Stage 3/6) matched this query
    //    forever: reclaim lock, retrigger smooth-responder, fail again,
    //    every cron tick, each retrigger a real attempted Anthropic call --
    //    which is what drove total_ai_call_attempts past the 20-call
    //    ceiling and tripped the GLOBAL circuit breaker, blocking every
    //    builder's AI calls platform-wide. Also proves an UNRELATED fresh
    //    batch (no failure recorded) is completely unaffected -- the fix is
    //    scoped to the poisoned batch only. ─────────────────────────────────
    {
      const staleUpdatedAt = new Date(Date.now() - 5 * 60_000).toISOString() // past the 3-minute grace

      // Poisoned batch: its document has a recorded Stage 1/2 AI failure.
      const poisonedJobId = crypto.randomUUID()
      createdJobIds.push(poisonedJobId)
      const [poisonedFile] = await makeJobAndFiles(supabase, poisonedJobId, ['poisoned.pdf'])
      const { batchRow: poisonedBatch } = await makeBatch(supabase, poisonedJobId, poisonedFile.id, [poisonedFile.id])
      await supabase.from('document_processing_jobs').update({ status: 'completed' }).eq('parent_job_id', poisonedBatch.id)
      await supabase.from('document_processing_batches').update({
        status: 'failed', classification_triggered: true, updated_at: staleUpdatedAt,
      }).eq('id', poisonedBatch.id)
      // Simulates what record_ai_failure (migration 043) already writes on
      // a genuine Stage 1/2 failure -- the exact signal this fix reads.
      await supabase.from('files').update({ ai_failure_count: 1, ai_failure_classification: 'budget_refused' }).eq('id', poisonedFile.id)

      // Unrelated healthy batch: same shape, no failure recorded -- must
      // remain eligible, proving the fix doesn't over-exclude.
      const healthyJobId = crypto.randomUUID()
      createdJobIds.push(healthyJobId)
      const [healthyFile] = await makeJobAndFiles(supabase, healthyJobId, ['healthy.pdf'])
      const { batchRow: healthyBatch } = await makeBatch(supabase, healthyJobId, healthyFile.id, [healthyFile.id])
      await supabase.from('document_processing_jobs').update({ status: 'completed' }).eq('parent_job_id', healthyBatch.id)
      await supabase.from('document_processing_batches').update({
        status: 'failed', classification_triggered: true, updated_at: staleUpdatedAt,
      }).eq('id', healthyBatch.id)

      const { data: stuckBatches, error: stuckErr } = await supabase.rpc('find_stuck_batches_needing_classification_retry')
      if (stuckErr) throw new Error(`find_stuck_batches_needing_classification_retry failed: ${stuckErr.message}`)
      const ids = (stuckBatches ?? []).map((b) => b.batch_id)
      assert(!ids.includes(poisonedBatch.id), 'a batch with a Stage 1/2 AI failure recorded on its document must never be eligible for classification retry again')
      assert(ids.includes(healthyBatch.id), 'an unrelated batch with no recorded failure must remain eligible for classification retry')
      results.scenarios.stage12_failed_batch_excluded_healthy_batch_unaffected = true
      log('scenario_passed', {
        scenario: 'stage12_failed_batch_excluded_healthy_batch_unaffected',
        poisoned_batch_id: poisonedBatch.id, healthy_batch_id: healthyBatch.id,
      })
    }

    // ── Scenario 8: a document that FAILED Stage 1/2 once but has SINCE
    //    genuinely succeeded (project_documents.extraction_status='complete'
    //    — the one atomic, authoritative "Stage 1/2 done" signal, migration
    //    050) must NOT permanently exclude its batch. Root cause this
    //    guards against, found live on job 1f12de7f-47b5-442e-9581-
    //    1f813796eb70 immediately after the Stage 1/2 truncation-recovery
    //    fix (commit f9b0233) started working: the target document failed
    //    once (ai_failure_count=1), then genuinely recovered and completed
    //    classification (97 facts persisted, stop_reason='tool_use') — but
    //    scenario 7's own exclusion (migration 088) tests ai_failure_count
    //    > 0 unconditionally, with no way to tell "still broken" apart from
    //    "recovered since." Confirmed live via 4 consecutive autonomous
    //    pg_cron ticks each reporting zero recovery action, and a direct
    //    RPC call returning batch_id absent. files.ai_failure_count is
    //    deliberately left non-zero here and never reset — it must remain
    //    accurate historical telemetry; the fix reads project_documents
    //    instead, not the counter. Also includes the inverse (still-
    //    unresolved) case explicitly, distinct from scenario 7's own
    //    coverage, colocated here for a single clear before/after
    //    comparison. ───────────────────────────────────────────────────────
    {
      const staleUpdatedAt = new Date(Date.now() - 5 * 60_000).toISOString() // past the 3-minute grace

      // Recovered batch: document failed once, but Stage 1/2 has SINCE
      // durably completed for it (extraction_status='complete'). Must be
      // eligible — this is the exact case migration 088 wrongly excluded.
      const recoveredJobId = crypto.randomUUID()
      createdJobIds.push(recoveredJobId)
      const [recoveredFile] = await makeJobAndFiles(supabase, recoveredJobId, ['recovered.pdf'])
      const { batchRow: recoveredBatch } = await makeBatch(supabase, recoveredJobId, recoveredFile.id, [recoveredFile.id])
      await supabase.from('document_processing_jobs').update({ status: 'completed' }).eq('parent_job_id', recoveredBatch.id)
      await supabase.from('document_processing_batches').update({
        status: 'failed', classification_triggered: true, updated_at: staleUpdatedAt,
      }).eq('id', recoveredBatch.id)
      // Historical failure signal — left in place, never cleared, exactly
      // as record_ai_failure would have left it after a genuine first
      // failure that was later recovered from on a subsequent attempt.
      await supabase.from('files').update({ ai_failure_count: 1, ai_failure_classification: 'truncated_response' }).eq('id', recoveredFile.id)
      // The one atomic signal that Stage 1/2 has SINCE genuinely succeeded
      // for this document (migration 050) — set directly here since this
      // test exercises the recovery predicate in isolation, not the full
      // persist_document_classification RPC (already covered elsewhere).
      const { error: pdErr } = await supabase.from('project_documents').insert({
        job_id: recoveredJobId, file_id: recoveredFile.id, extraction_status: 'complete', document_type: 'architectural_plan',
      })
      if (pdErr) throw new Error(`project_documents insert failed: ${pdErr.message}`)

      // Unresolved batch: document failed once, and Stage 1/2 has NOT since
      // completed for it (no project_documents row at all) — must remain
      // excluded, proving the fix doesn't over-include a still-broken
      // document just because SOME batch nearby recovered.
      const unresolvedJobId = crypto.randomUUID()
      createdJobIds.push(unresolvedJobId)
      const [unresolvedFile] = await makeJobAndFiles(supabase, unresolvedJobId, ['unresolved.pdf'])
      const { batchRow: unresolvedBatch } = await makeBatch(supabase, unresolvedJobId, unresolvedFile.id, [unresolvedFile.id])
      await supabase.from('document_processing_jobs').update({ status: 'completed' }).eq('parent_job_id', unresolvedBatch.id)
      await supabase.from('document_processing_batches').update({
        status: 'failed', classification_triggered: true, updated_at: staleUpdatedAt,
      }).eq('id', unresolvedBatch.id)
      await supabase.from('files').update({ ai_failure_count: 1, ai_failure_classification: 'truncated_response' }).eq('id', unresolvedFile.id)

      const { data: stuckBatches2, error: stuckErr2 } = await supabase.rpc('find_stuck_batches_needing_classification_retry')
      if (stuckErr2) throw new Error(`find_stuck_batches_needing_classification_retry failed: ${stuckErr2.message}`)
      const ids2 = (stuckBatches2 ?? []).map((b) => b.batch_id)
      assert(ids2.includes(recoveredBatch.id), 'a batch whose document failed once but has since durably completed Stage 1/2 (extraction_status=complete) must become eligible for classification retry again')
      assert(!ids2.includes(unresolvedBatch.id), 'a batch whose document failed and has NOT since completed Stage 1/2 must remain excluded from classification retry')

      // ai_failure_count must remain untouched historical telemetry — the
      // fix must never reset it merely to make the predicate work.
      const { data: recoveredFileAfter } = await supabase.from('files').select('ai_failure_count, ai_failure_classification').eq('id', recoveredFile.id).single()
      assert(recoveredFileAfter?.ai_failure_count === 1, `ai_failure_count must remain historically accurate (1), got ${recoveredFileAfter?.ai_failure_count}`)
      assert(recoveredFileAfter?.ai_failure_classification === 'truncated_response', 'ai_failure_classification must remain historically accurate, not cleared')

      results.scenarios.recovered_document_batch_becomes_eligible_unresolved_stays_excluded = true
      log('scenario_passed', {
        scenario: 'recovered_document_batch_becomes_eligible_unresolved_stays_excluded',
        recovered_batch_id: recoveredBatch.id, unresolved_batch_id: unresolvedBatch.id,
      })
    }

    results.passed = true
    log('queue_check_passed', results)
  } catch (err) {
    results.error = err instanceof Error ? err.message : String(err)
    log('queue_check_failed', results)
  } finally {
    for (const jobId of createdJobIds) {
      try {
        await supabase.from('files').delete().eq('job_id', jobId)
        await supabase.from('jobs').delete().eq('id', jobId)
      } catch (cleanupErr) {
        log('queue_check_cleanup_failed', { job_id: jobId, error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) })
      }
    }
    log('queue_check_cleanup_complete', { job_ids: createdJobIds })
  }

  process.exit(results.passed ? 0 : 1)
}

main()
