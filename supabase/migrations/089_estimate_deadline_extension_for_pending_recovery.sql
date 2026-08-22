-- ── 089: don't let the 15-minute SLA finalize a batch that is legitimately
--         waiting for its next automatic recovery attempt ─────────────────
--
-- Root cause this closes (found live, 2026-08-22, batch
-- 416f0dae-06ae-495b-9789-3ebeb8eb28ff): Stage 6 bails cleanly and
-- persists a resumable checkpoint (scope_reasoning_completed_at,
-- stall_stage/stall_reason — migration 053) when a single edge-function
-- invocation doesn't have enough wall-clock budget left to safely start
-- it. That checkpoint-and-resume design already IS "persist state, exit
-- cleanly, resume independently" — it does not depend on the SSE
-- connection or the Next.js request in any way (smooth-responder runs via
-- EdgeRuntime.waitUntil, fully detached from the client). The gap was
-- never the resumability itself: it's that enforce_estimate_deadlines
-- (migration 078) finalizes builder_status purely off a fixed
-- deadline_at set at upload time, with no awareness of whether the batch
-- is still within its automatic classification-retry budget. Observed
-- live: the SLA finalized this exact batch as NEEDS_REVIEW at 05:40:00
-- UTC, and find_stuck_batches_needing_classification_retry's own
-- builder_status IS NOT NULL exclusion (migration 078, by design) then
-- permanently blocked any further automatic retry -- even though the
-- batch had a completed Stage 3 checkpoint, zero AI failures, and was
-- otherwise a textbook case for a one-invocation resume.
--
-- Fix: enforce_estimate_deadlines now extends deadline_at (bounded,
-- 3 times max, +6 minutes each) instead of finalizing, for a batch that
-- currently matches the SAME eligibility predicate
-- find_stuck_batches_needing_classification_retry already uses (minus
-- its own staleness grace window) and has no persisted result yet
-- (quote_id IS NULL). This is deliberately not a new state machine or a
-- new queue -- it reuses the exact columns/predicate the retry cron
-- already trusts, so "is this batch pending recovery" and "is this batch
-- eligible for retry" can never drift apart. A batch that genuinely
-- exhausts its extension budget (3 extensions ~= up to ~18 extra
-- minutes, bounded, not indefinite) or was never checkpoint/retry-
-- eligible in the first place (a cold stall, a real Stage 3/6 failure, an
-- AI failure, a live lock) still finalizes exactly as before -- the SLA
-- keeps protecting against genuinely abandoned jobs, it just no longer
-- races ahead of a job that has a real, bounded, in-flight recovery path.

ALTER TABLE estimate_runs
  ADD COLUMN IF NOT EXISTS deadline_extensions_used integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN estimate_runs.deadline_extensions_used IS
  'How many times enforce_estimate_deadlines has extended this run''s deadline_at instead of finalizing it, because the batch was still within its automatic classification-retry budget. Bounded (see MAX_DEADLINE_EXTENSIONS in enforce_estimate_deadlines) -- this can never grow without limit.';

CREATE OR REPLACE FUNCTION enforce_estimate_deadlines()
RETURNS TABLE(estimate_run_id uuid, job_id uuid, batch_id uuid, builder_status text, reason text) AS $$
DECLARE
  r record;
  v_status text;
  v_reason text;
  v_extended boolean;
  v_max_extensions constant integer := 3;
  v_extension constant interval := interval '6 minutes';
BEGIN
  FOR r IN
    SELECT er.id, er.job_id, er.batch_id, er.status, er.deadline_extensions_used
    FROM estimate_runs er
    WHERE er.deadline_at < now()
      AND er.builder_status IS NULL
    FOR UPDATE SKIP LOCKED
  LOOP
    v_extended := false;

    -- Is this batch still a live, bounded, automatic-recovery candidate?
    -- Same predicate find_stuck_batches_needing_classification_retry uses
    -- (minus its own updated_at grace window, irrelevant here -- we only
    -- care whether the batch is STRUCTURALLY eligible, not whether the
    -- retry cron's own grace period has elapsed yet) plus quote_id IS
    -- NULL, so a batch that already has a persisted result is always
    -- finalized immediately rather than pointlessly extended.
    IF r.deadline_extensions_used < v_max_extensions AND EXISTS (
      SELECT 1
      FROM document_processing_batches b
      WHERE b.id = r.batch_id
        AND b.quote_id IS NULL
        AND b.status IN ('completed', 'completed_with_failures', 'failed')
        AND b.classification_triggered = true
        AND b.stage3_failure_count = 0
        AND b.stage6_failure_count = 0
        AND NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = b.job_id)
        AND NOT EXISTS (
          SELECT 1 FROM document_processing_jobs j
          JOIN files f ON f.id = j.document_id
          WHERE j.parent_job_id = b.id AND f.ai_failure_count > 0
        )
    ) THEN
      UPDATE estimate_runs
      SET deadline_at = now() + v_extension,
          deadline_extensions_used = deadline_extensions_used + 1
      WHERE id = r.id;

      INSERT INTO estimate_run_events (estimate_run_id, from_status, to_status, detail)
      VALUES (r.id, r.status, r.status, jsonb_build_object(
        'event', 'deadline_extended_pending_recovery',
        'extensions_used', r.deadline_extensions_used + 1,
        'max_extensions', v_max_extensions
      ));

      v_extended := true;
    END IF;

    IF NOT v_extended THEN
      SELECT cbs.builder_status, cbs.reason INTO v_status, v_reason FROM compute_builder_status(r.batch_id) cbs;
      v_reason := format('15-minute processing window exceeded (was in stage: %s). %s', r.status, v_reason);

      UPDATE estimate_runs
      SET builder_status = v_status,
          needs_review_reason = v_reason,
          completed_at = COALESCE(completed_at, now())
      WHERE id = r.id;

      INSERT INTO estimate_run_events (estimate_run_id, from_status, to_status, detail)
      VALUES (r.id, r.status, r.status, jsonb_build_object(
        'event', 'deadline_enforced', 'builder_status', v_status, 'reason', v_reason
      ));

      estimate_run_id := r.id; job_id := r.job_id; batch_id := r.batch_id;
      builder_status := v_status; reason := v_reason;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION enforce_estimate_deadlines IS
  'The 15-minute SLA watchdog. Finds every estimate_runs row whose deadline_at has passed with builder_status still NULL. As of migration 089, a batch that is still a live, bounded, classification-retry-eligible candidate (Stage 3 checkpointed, no failures, no lock, no persisted quote yet) gets deadline_at pushed forward (bounded to 3 extensions of 6 minutes each) instead of being finalized -- this is what stops the SLA from declaring NEEDS_REVIEW on a job that is correctly queued for its next automatic Stage 6 resume attempt. Every other batch (extensions exhausted, or never retry-eligible to begin with -- a cold stall, a real failure, a live lock) is finalized exactly as before via compute_builder_status. Called from GET /api/cron/intake-recovery on every tick, independent of DOCUMENT_RECOVERY_DISABLED/AI_RECOVERY_DISABLED (neither extending a deadline nor finalizing a status makes an Anthropic call or triggers a worker).';
