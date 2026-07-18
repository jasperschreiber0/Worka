-- 046_abandoned_file_recovery.sql
-- Closes the second half of "no worker is running, no progress is
-- happening, no user-visible failure exists": migration 045 fixed the
-- job_intake_locks side of that (the lock no longer blocks the JOB
-- forever), but did nothing for the FILE's own intake_status — a file
-- whose lock was cleared (or that never had one in the first place, e.g.
-- intake_status='uploaded' because the SSE trigger was never even opened)
-- is left sitting at 'uploaded'/'queued'/'processing' indefinitely, with
-- nothing ever marking it resolved. Over repeated retries on the same job
-- (exactly what happened during today's testing) these accumulate
-- silently — the direct cause of a job showing "173 plans uploaded but
-- not yet processed" for what was actually 7 real documents retried many
-- times.
--
-- find_and_fail_abandoned_files is read+write but purely a files.
-- intake_status bookkeeping operation: no Anthropic call, no
-- smooth-responder/document-worker fetch, no estimation logic touched.
-- Safe for the DOCUMENT_RECOVERY (not AI_RECOVERY) path.
--
-- A file is only a candidate once BOTH:
--   - it's been sitting in a non-terminal status for longer than
--     p_stale_after (default 2 hours — comfortably longer than the SSE
--     poller's own 15-minute OVERALL_TIMEOUT_MS, so this can never touch
--     a run a connected client would still consider live), AND
--   - its job currently holds no job_intake_locks row at all (NOT a
--     staleness check on the lock — literal absence). A job with an
--     active or even a stale-but-not-yet-reclaimed lock is left alone;
--     migration 045's release_stale_job_intake_lock is what clears that
--     first, and it runs in the same cron tick just before this step.
CREATE OR REPLACE FUNCTION find_and_fail_abandoned_files(p_stale_after interval DEFAULT interval '2 hours')
RETURNS TABLE(file_id uuid, job_id uuid, filename text, previous_status text, age interval) AS $$
  WITH candidates AS (
    SELECT f.id, f.job_id, f.filename, f.intake_status, f.created_at
    FROM files f
    WHERE f.intake_status IN ('uploaded', 'queued', 'processing')
      AND f.created_at < now() - p_stale_after
      AND NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = f.job_id)
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
  'Marks files.intake_status=failed for uploads that have been non-terminal for over p_stale_after with no job_intake_locks row protecting them — closes the "silently stuck forever, no visible failure" gap for the file itself (migration 045 closed the equivalent gap for the job-level lock). Read+write on files only; never calls Anthropic, never triggers smooth-responder or document-worker.';

ALTER TABLE intake_recovery_runs
  ADD COLUMN IF NOT EXISTS abandoned_files_marked_failed integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN intake_recovery_runs.abandoned_files_marked_failed IS
  'Files marked intake_status=failed this run by find_and_fail_abandoned_files — genuinely abandoned uploads (2+ hours non-terminal, no lock protecting the job), not active runs.';
