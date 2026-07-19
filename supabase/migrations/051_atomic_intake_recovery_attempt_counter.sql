-- 051_atomic_intake_recovery_attempt_counter.sql
-- Replaces the JS-side SELECT-then-UPDATE of files.intake_recovery_attempts
-- in app/api/cron/intake-recovery/route.ts (both the stale-lock-reclaim
-- path and the stuck-classification-retry path) with a single atomic
-- function, following the exact pattern already used for
-- document_processing_jobs' retry counter (retry_or_fail_document_job,
-- migration 034) and files.ai_failure_count (record_ai_failure, migration
-- 043).
--
-- Root cause this closes: the JS code did
--   const { data: fileRow } = await supabase.from('files').select(...).eq(...).single()
--   const attempts = fileRow?.intake_recovery_attempts ?? 0
--   ...
--   await supabase.from('files').update({ intake_recovery_attempts: attempts + 1 }).eq(...)
-- with the `error` on BOTH the select and the update never checked. Any
-- failure on either call — a stale PostgREST schema cache not yet knowing
-- about this column (the exact "not found in schema cache" failure mode
-- this codebase has hit before, see CLAUDE.md), a transient network error,
-- a race between two overlapping recovery-cron invocations reading the same
-- prior value — silently defaults `attempts` to 0 and silently drops the
-- write. Observed in production: a single file was reclaimed/retried on
-- every single cron run (once a minute) with recovery_attempts logged as 1
-- every time, and intake_recovery_runs.files_permanently_failed stayed at
-- 0 across 8+ consecutive runs — conclusive evidence the counter was never
-- actually advancing past 1, defeating MAX_RECOVERY_ATTEMPTS entirely and
-- reproducing the same class of unbounded-retry spend risk migration 040
-- was written to close.
--
-- SELECT ... FOR UPDATE below holds a row lock for the duration of the
-- function's implicit transaction, so a concurrent second call (step 4 and
-- step 5 in route.ts are mutually exclusive per file per run by
-- construction, but two overlapping cron invocations are not impossible)
-- blocks until the first commits, then reads the already-incremented
-- state — no lost updates. The caller MUST check the RPC's own `error`
-- (unlike the code this replaces) — a Postgres-level failure now surfaces
-- as a thrown error the route's existing try/catch already handles, instead
-- of silently behaving as if this were the file's first-ever attempt.

CREATE OR REPLACE FUNCTION record_intake_recovery_attempt(
  p_file_id uuid,
  p_max_attempts int,
  p_cap_reason text
)
RETURNS TABLE(prior_attempts int, capped boolean, found boolean) AS $$
DECLARE
  v_prior int;
BEGIN
  SELECT intake_recovery_attempts INTO v_prior
  FROM files
  WHERE id = p_file_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- File row doesn't exist (deleted, or a bad id) — nothing to record.
    -- Matches this route's existing best-effort posture elsewhere: a
    -- lookup failure here must never throw and break the rest of the run.
    RETURN QUERY SELECT 0, false, false;
    RETURN;
  END IF;

  IF v_prior >= p_max_attempts THEN
    UPDATE files
    SET intake_status = 'failed',
        failure_reason = p_cap_reason
    WHERE id = p_file_id;
    RETURN QUERY SELECT v_prior, true, true;
  ELSE
    UPDATE files
    SET intake_recovery_attempts = v_prior + 1
    WHERE id = p_file_id;
    RETURN QUERY SELECT v_prior, false, true;
  END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION record_intake_recovery_attempt IS
  'Atomically reads, caps-checks, and increments files.intake_recovery_attempts (or marks the file permanently failed once p_max_attempts is reached) in one transaction via SELECT...FOR UPDATE — replaces a race-prone, error-unchecked JS-side read-modify-write in app/api/cron/intake-recovery/route.ts. Mirrors record_ai_failure (migration 043) and retry_or_fail_document_job (migration 034).';
