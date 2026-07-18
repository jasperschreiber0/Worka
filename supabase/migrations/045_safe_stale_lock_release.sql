-- 045_safe_stale_lock_release.sql
-- Adds intake_recovery_runs.stale_locks_released, the audit counter for the
-- new SAFE stale-lock-release step in GET /api/cron/intake-recovery (step
-- 3b, DOCUMENT_RECOVERY_DISABLED path — never calls Anthropic, never
-- triggers smooth-responder).
--
-- Root cause this closes: job_intake_locks is created by the upload route
-- BEFORE the processing chain starts, but is only ever released from
-- inside smooth-responder's own try/finally. If the handoff into
-- smooth-responder is lost (triggerClassification's fire-and-forget fetch
-- never lands — see supabase/functions/document-worker/index.ts),
-- smooth-responder never starts, so nothing ever releases the lock — it
-- sits open forever, silently blocking every future processing attempt on
-- that job with no worker running and no user-visible failure. The new
-- step reclaims (deletes) such a lock on the recovery cron's own fixed
-- schedule, independent of whether anyone retries the upload — same
-- staleness definition (6min no-progress / 16min absolute) tryAcquireJobLock
-- already uses inline, just running even when nobody uploads again.

ALTER TABLE intake_recovery_runs
  ADD COLUMN IF NOT EXISTS stale_locks_released integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN intake_recovery_runs.stale_locks_released IS
  'job_intake_locks rows deleted this run because they were stale (find_stale_job_intake_locks) and no downstream run could reach the code that would otherwise release them. Safe: this step only deletes — it never re-acquires the lock and never triggers smooth-responder, so it carries no Anthropic spend risk regardless of AI_RECOVERY_DISABLED.';

-- ─── release_stale_job_intake_lock ─────────────────────────────────────────
-- Atomic release, not a plain DELETE keyed off an earlier SELECT's result.
-- find_stale_job_intake_locks (migration 037) is a plain read — by the time
-- a caller acts on one of its rows, a genuinely new run could have
-- reclaimed and re-acquired that same job_id's lock in the gap (a brand
-- new lock is indistinguishable from the stale one by job_id alone). This
-- function re-verifies staleness under FOR UPDATE at the moment it
-- deletes, exactly the same pattern acquire_or_reclaim_job_intake_lock
-- already uses for the same reason — it just deletes instead of also
-- inserting a replacement, since this caller (the SAFE recovery step) has
-- no new run to hand the lock to.
CREATE OR REPLACE FUNCTION release_stale_job_intake_lock(
  p_job_id uuid,
  p_no_progress_stale interval DEFAULT interval '6 minutes',
  p_absolute_stale interval DEFAULT interval '16 minutes'
)
RETURNS TABLE(released boolean, file_id uuid, started_at timestamptz, last_progress_at timestamptz, stale_for interval) AS $$
DECLARE
  v_row job_intake_locks;
BEGIN
  SELECT * INTO v_row FROM job_intake_locks WHERE job_id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Already released (by a concurrent recovery pass, or the run itself
    -- finishing normally in between) — nothing to do, not an error.
    RETURN QUERY SELECT false, NULL::uuid, NULL::timestamptz, NULL::timestamptz, NULL::interval;
    RETURN;
  END IF;

  IF (now() - v_row.last_progress_at > p_no_progress_stale) OR (now() - v_row.started_at > p_absolute_stale) THEN
    DELETE FROM job_intake_locks WHERE job_id = p_job_id;
    RETURN QUERY SELECT true, v_row.file_id, v_row.started_at, v_row.last_progress_at,
      GREATEST(now() - v_row.last_progress_at, now() - v_row.started_at);
    RETURN;
  END IF;

  -- Made real progress since the earlier read that found this candidate —
  -- correctly left alone, exactly like acquire_or_reclaim_job_intake_lock's
  -- own re-check.
  RETURN QUERY SELECT false, v_row.file_id, v_row.started_at, v_row.last_progress_at, NULL::interval;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION release_stale_job_intake_lock IS
  'Atomically re-verifies staleness (SELECT...FOR UPDATE) and deletes a job_intake_locks row if still stale — the SAFE half of lock recovery: deletes only, never inserts a replacement, never touches smooth-responder. Used by GET /api/cron/intake-recovery''s document-recovery path.';
