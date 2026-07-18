-- 043_atomic_ai_failure_counter.sql
-- Replaces the JS-side SELECT-then-UPDATE in recordAiFailure
-- (supabase/functions/smooth-responder/index.ts) with a single atomic
-- function, following the same pattern already used for
-- document_processing_jobs' own retry counter (retry_or_fail_document_job,
-- migration 034).
--
-- Production readiness review finding (blocking issue 3): the retry cap
-- protecting Anthropic spend was implemented as a non-atomic read-modify-
-- write — two overlapping smooth-responder invocations for the same job
-- (a real possibility: reclaiming a stale job_intake_lock does not kill
-- the physical old invocation still running server-side, see
-- acquire_or_reclaim_job_intake_lock's own comment, migration 037) could
-- both read the same prior ai_failure_count, both compute the same "next"
-- state, and one increment would be lost — undermining the exact
-- safety guarantee this counter exists to provide. SELECT ... FOR UPDATE
-- below holds a row lock for the duration of the function's implicit
-- transaction, so a concurrent second call blocks until the first commits
-- and then reads the ALREADY-INCREMENTED state — no lost updates, no
-- double-counting, regardless of how many callers race it.
--
-- p_max_occurrences mirrors maxConsecutiveOccurrences (pipeline-logic.ts)
-- exactly — the caller (recordAiFailure, index.ts) computes the threshold
-- for the classification it saw and passes it in, keeping the
-- classification taxonomy in one place (pipeline-logic.ts, unit-tested)
-- while this function only does the generic "atomic counter with a
-- threshold" mechanics:
--   0 — never worth even one retry; stops on the very first occurrence.
--   1 — one more attempt at a smaller size is worth it (application_timeout /
--       context_window_exceeded); stops on the SECOND identical occurrence.
--   2 — matches the existing tolerance for genuinely transient failures
--       (network_interruption / rate_limited / overloaded).

CREATE OR REPLACE FUNCTION record_ai_failure(
  p_file_id uuid,
  p_classification text,
  p_reason text,
  p_max_occurrences int
)
RETURNS TABLE(classification text, occurrence_count int, stopped boolean) AS $$
DECLARE
  v_prior_classification text;
  v_prior_count int;
  v_next_count int;
  v_stop boolean;
BEGIN
  SELECT ai_failure_classification, ai_failure_count
  INTO v_prior_classification, v_prior_count
  FROM files
  WHERE id = p_file_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- File row doesn't exist (deleted, or a bad id) — nothing to record.
    -- Matches the pre-existing best-effort posture: a lookup failure here
    -- must never throw and break the caller's own failure handling.
    RETURN QUERY SELECT p_classification, 0, false;
    RETURN;
  END IF;

  IF v_prior_classification = p_classification THEN
    v_next_count := v_prior_count + 1;
  ELSE
    v_next_count := 1;
  END IF;

  v_stop := (p_max_occurrences <= 0)
    OR (v_prior_classification = p_classification AND v_prior_count >= p_max_occurrences);

  UPDATE files
  SET ai_failure_classification = p_classification,
      ai_failure_count = v_next_count,
      intake_status = CASE WHEN v_stop THEN 'failed' ELSE intake_status END,
      failure_stage = CASE WHEN v_stop THEN 'AI_REASONING_FAILED' ELSE failure_stage END,
      failure_reason = CASE WHEN v_stop THEN
        left(
          'Automatic AI processing stopped after '
            || (CASE WHEN v_next_count = 1 THEN 'a non-retryable' ELSE v_next_count || ' repeated' END)
            || ' ' || p_classification || ' failure' || (CASE WHEN v_next_count = 1 THEN '' ELSE 's' END)
            || ' — ' || p_reason || '. Manual intervention required (re-upload after resolving the underlying issue).',
          500
        )
        ELSE failure_reason END
  WHERE id = p_file_id;

  RETURN QUERY SELECT p_classification, v_next_count, v_stop;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION record_ai_failure IS
  'Atomically records an Anthropic call failure classification against a file (files.ai_failure_classification/ai_failure_count) and decides, in the same transaction via SELECT...FOR UPDATE, whether to permanently stop (intake_status=failed) — replaces a race-prone JS-side read-modify-write. p_max_occurrences mirrors maxConsecutiveOccurrences in pipeline-logic.ts; keep both in sync if either changes.';
