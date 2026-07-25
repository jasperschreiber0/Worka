-- 075_document_recovery_abandoned_file_exclusion.sql
-- Fixes the confirmed root cause of the DOCUMENT_RECOVERY_DISABLED oscillation
-- (app/api/cron/intake-recovery/route.ts's own header comment, 2026-07-19,
-- already traced this precisely — this migration implements the first of the
-- two fixes it proposed).
--
-- find_and_fail_abandoned_files (migration 046) writes
-- `files.intake_status = 'failed'` directly for a file that's been
-- non-terminal for 2+ hours with no job_intake_locks row protecting it — the
-- correct outcome for a genuinely abandoned single-document upload whose one
-- worker died. But reclaim_stale_document_jobs and find_batches_with_claimable_
-- work (migrations 036/037), which run in the SAME cron pass just before
-- find_and_fail_abandoned_files, have no awareness of that mark: they'll
-- happily reclaim a stale-but-still-attemptable document_processing_jobs row
-- for that same file and fire a fresh document-worker invocation. That worker
-- calls recompute_file_intake_status (migration 052) on completion, which
-- re-derives 'processing' from the file's own (now non-terminal-again) job
-- row — silently undoing the abandoned mark. The next cron tick sees
-- 'processing' again, re-marks it 'failed', and the cycle repeats forever:
-- confirmed live in production logs (find_and_fail_abandoned_files reporting
-- previous_status: 'processing' on the same two files every single tick, with
-- ai_recovery_enabled: false ruling out the unrelated Anthropic-spend
-- incident as the cause).
--
-- Fix: a file already marked abandoned-and-failed is terminal from the
-- document-recovery service's own perspective — reclaiming or re-triggering
-- work for it defeats the mark that was just made. Both functions below now
-- exclude any document_processing_jobs row whose file already carries
-- intake_status = 'failed' AND failure_stage = 'ABANDONED'. This is narrowly
-- scoped to that one failure_stage value (not any 'failed' file) so it never
-- touches a file that failed for an ordinary, already-correctly-terminal
-- reason (extraction failure past its own 3-attempt cap, an AI billing halt,
-- etc.) — those files' document_processing_jobs rows are already 'failed'
-- themselves and were never reclaimable in the first place; this exclusion
-- only matters for the specific case where the FILE was declared abandoned
-- by the 2-hour/no-lock rule while its own job row was still technically
-- retryable.

CREATE OR REPLACE FUNCTION reclaim_stale_document_jobs(
  p_stale_after interval DEFAULT interval '3 minutes',
  p_parent_job_id uuid DEFAULT NULL
)
RETURNS TABLE(reclaimed_job_id uuid, reclaimed_parent_job_id uuid, new_status text) AS $$
DECLARE
  v_job record;
  v_result record;
BEGIN
  FOR v_job IN
    SELECT id, parent_job_id
    FROM document_processing_jobs
    WHERE status = 'running' AND locked_at IS NOT NULL AND locked_at < now() - p_stale_after
      AND (p_parent_job_id IS NULL OR parent_job_id = p_parent_job_id)
      AND NOT EXISTS (
        SELECT 1 FROM files f
        WHERE f.id = document_processing_jobs.document_id
          AND f.intake_status = 'failed'
          AND f.failure_stage = 'ABANDONED'
      )
    ORDER BY locked_at
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT r.new_status, r.should_trigger_classification
    INTO v_result
    FROM retry_or_fail_document_job(
      v_job.id,
      format('reclaimed: stale running job, no update since %s (worker invocation likely crashed or was killed)', p_stale_after),
      3
    ) r;

    reclaimed_job_id := v_job.id;
    reclaimed_parent_job_id := v_job.parent_job_id;
    new_status := v_result.new_status;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reclaim_stale_document_jobs IS
  'Requeues (or permanently fails, past 3 attempts) any document_processing_jobs row stuck at status=''running'' with a locked_at older than p_stale_after — the queue-model analogue of job_intake_locks'' staleness reclaim (migration 033). Safe to call repeatedly; FOR UPDATE SKIP LOCKED means a row a worker is still genuinely processing is never double-handled. Excludes any row whose file was already marked abandoned (migration 075) — reclaiming it would just resurrect a file the recovery service already declared terminal, the root cause of the DOCUMENT_RECOVERY oscillation this migration closes.';

CREATE OR REPLACE FUNCTION find_batches_with_claimable_work()
RETURNS TABLE(parent_job_id uuid, job_id uuid, builder_id uuid, pending_count bigint) AS $$
  SELECT b.id, b.job_id, b.builder_id, count(j.id)
  FROM document_processing_batches b
  JOIN document_processing_jobs j ON j.parent_job_id = b.id
  WHERE b.status IN ('pending', 'running')
    AND j.status = 'pending'
    AND j.run_after <= now()
    AND NOT EXISTS (
      SELECT 1 FROM files f
      WHERE f.id = j.document_id
        AND f.intake_status = 'failed'
        AND f.failure_stage = 'ABANDONED'
    )
  GROUP BY b.id, b.job_id, b.builder_id;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION find_batches_with_claimable_work IS
  'Batches with at least one claimable (pending, run_after due) document_processing_jobs row. Non-empty for a batch for more than a cron cycle means its worker chain has stopped self-sustaining (see triggerNext) — the recovery cron fires one fresh document-worker invocation per row returned, which is enough to resume the whole chain. Excludes any row whose file was already marked abandoned (migration 075) — same reasoning as reclaim_stale_document_jobs above; without this a job reclaimed to ''pending'' by some other path could still be picked up and re-triggered here even after being declared terminal.';

NOTIFY pgrst, 'reload schema';
