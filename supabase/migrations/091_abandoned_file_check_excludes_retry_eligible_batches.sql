-- ── 091: stop find_and_fail_abandoned_files racing the classification-retry
--         cron for a batch that is actively, successfully resuming ────────
--
-- Root cause found live, 2026-08-23, on a real production job (batch
-- d58c3e92-d16f-425d-ad78-fbc5e8d0c86e): confirmed directly in Railway
-- deploy logs, every single cron tick (once a minute) shows BOTH
-- abandoned_file_marked_failed (step 3c, DOCUMENT_RECOVERY) AND
-- recovery_classification_retriggered (step 5, AI_RECOVERY) firing for the
-- SAME file, in the SAME tick, indefinitely -- recovery_attempts climbing
-- toward MAX_RECOVERY_ATTEMPTS (3) with no actual progress, because the two
-- steps are fighting each other rather than cooperating.
--
-- Mechanism: find_and_fail_abandoned_files (migration 046) treats "no
-- job_intake_locks row for this job" as evidence of abandonment. That's
-- correct for a genuinely dead run. But once Stage 3 is checkpointed
-- (migration 053) and a batch is resuming straight to Stage 6, each
-- resumed smooth-responder invocation is brief -- the lock exists only
-- transiently, for the seconds/minutes the invocation is actually running,
-- and is released (via the pipeline's own try/finally) the moment it
-- either completes or wall-clock-bails again. For MOST of any given
-- 60-second cron interval, no lock exists, even though the batch is being
-- actively and successfully worked on: this function's own precondition
-- ("no lock" = "abandoned") is simply wrong for this specific, otherwise-
-- healthy case. Step 3c runs BEFORE step 5 in the same route invocation
-- (see app/api/cron/intake-recovery/route.ts), so every single tick: 3c
-- marks the file 'failed' (previous_status: 'processing', matching the
-- exact "Known open issue" oscillation this project's own CLAUDE.md
-- already documented as observed-but-unconfirmed); 3c's own write is then
-- overwritten back to 'processing' by files.intake_status's derived-
-- projection recompute (migration 052) once the freshly-retriggered
-- invocation progresses; and the cycle repeats next tick, burning the
-- shared recovery-attempts counter (record_intake_recovery_attempt,
-- migration 051) on nothing but its own churn -- not on genuine failed
-- attempts at the underlying work, which was in fact converging correctly
-- (stage3_completed_trade_ids intact, zero AI failures, zero stage3/6
-- failure counts). Left unfixed, this permanently fails an otherwise-
-- healthy, actively-progressing job the moment the shared attempt cap is
-- exhausted by the oscillation alone.
--
-- Fix: add ONE more exclusion to find_and_fail_abandoned_files's candidate
-- set -- do not touch a file whose document_processing_batches row is
-- otherwise a structurally legitimate automatic-resume candidate. This is
-- deliberately the EXACT SAME eligibility predicate
-- find_stuck_batches_needing_classification_retry (migration 088) already
-- uses to decide "this batch deserves another automatic retry", so "is
-- this file being actively recovered elsewhere" and "should step 3c leave
-- it alone" can never drift apart -- the same reasoning migration 089
-- already applied to enforce_estimate_deadlines for the identical class of
-- problem (a bounded, in-flight, legitimate recovery candidate must not be
-- clobbered by a DIFFERENT part of this same cron that has no visibility
-- into that recovery being under way). A file whose batch has genuinely
-- stalled for real reasons (an AI failure, a real stage3/6 failure count,
-- or a batch that was never classification-triggered to begin with) is
-- completely unaffected and still correctly caught as abandoned.

CREATE OR REPLACE FUNCTION find_and_fail_abandoned_files(p_stale_after interval DEFAULT interval '2 hours')
RETURNS TABLE(file_id uuid, job_id uuid, filename text, previous_status text, age interval) AS $$
  WITH candidates AS (
    SELECT f.id, f.job_id, f.filename, f.intake_status, f.created_at
    FROM files f
    WHERE f.intake_status IN ('uploaded', 'queued', 'processing')
      AND f.created_at < now() - p_stale_after
      AND NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = f.job_id)
      AND NOT EXISTS (
        -- Same predicate find_stuck_batches_needing_classification_retry
        -- uses (minus its own updated_at grace window, irrelevant here --
        -- this only asks whether the batch is STRUCTURALLY still a live,
        -- bounded, automatic-retry candidate, exactly like migration 089's
        -- enforce_estimate_deadlines extension check does for the same
        -- reason).
        SELECT 1 FROM document_processing_batches b
        WHERE b.id = f.processing_batch_id
          AND b.status IN ('completed', 'completed_with_failures', 'failed')
          AND b.classification_triggered = true
          AND b.stage3_failure_count = 0
          AND b.stage6_failure_count = 0
          AND NOT EXISTS (
            SELECT 1 FROM estimate_runs er WHERE er.batch_id = b.id AND er.builder_status IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM document_processing_jobs j
            JOIN files ff ON ff.id = j.document_id
            WHERE j.parent_job_id = b.id AND ff.ai_failure_count > 0
          )
      )
    FOR UPDATE SKIP LOCKED
  ),
  updated AS (
    UPDATE files
    SET intake_status = 'failed',
        failure_stage = 'ABANDONED',
        failure_reason = left(
          'No processing activity detected for over ' || p_stale_after::text ||
          ' since upload — automatically marked failed by the document-recovery service so it stops appearing as silently stuck. Re-upload to retry.',
          500
        )
    FROM candidates c
    WHERE files.id = c.id
    RETURNING files.id
  )
  SELECT c.id, c.job_id, c.filename, c.intake_status, now() - c.created_at
  FROM candidates c
  JOIN updated u ON u.id = c.id;
$$ LANGUAGE sql;

COMMENT ON FUNCTION find_and_fail_abandoned_files IS
  'Marks files.intake_status=failed for uploads that have been non-terminal for over p_stale_after with no job_intake_locks row protecting them — closes the "silently stuck forever, no visible failure" gap for the file itself (migration 045 closed the equivalent gap for the job-level lock). As of migration 091, also excludes any file whose document_processing_batches row is still a structurally legitimate classification-retry candidate (same predicate as find_stuck_batches_needing_classification_retry, migration 088) — closes a live, confirmed oscillation where this function and the classification-retry step (route.ts step 5) fought over the same file every single cron tick, each one briefly acquiring/releasing job_intake_locks between ticks, burning the shared recovery-attempts cap on churn instead of genuine failures. Read+write on files only; never calls Anthropic, never triggers smooth-responder or document-worker.';

NOTIFY pgrst, 'reload schema';
