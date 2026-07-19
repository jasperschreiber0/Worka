-- ============================================================
-- WorkA — Phase 1 observation-phase fix: stall_reason is a sticky,
-- write-once diagnostic column, not live state
-- ============================================================
-- Context: the first real production sample from find_estimate_run_mismatches
-- / estimate_run_events showed a run transition awaiting_clarification ->
-- stalled a few minutes after correctly reaching awaiting_clarification.
-- Traced to source: document_processing_batches.stall_reason/stalled_at/
-- stall_stage (migration 053) are written EXACTLY ONCE, by
-- bailForWallClockBudget in supabase/functions/smooth-responder/index.ts,
-- and are NEVER cleared anywhere in the codebase -- not on a later
-- successful retry against the same batch row, not by any recovery step,
-- not by any other migration. They're a permanent "this batch stalled at
-- least once" breadcrumb, not a "this batch is CURRENTLY stalled" flag.
--
-- derive_estimate_run_projection (migration 057) treated
-- `stall_reason IS NOT NULL` as "currently stalled" and let it
-- unconditionally override every other structural status, including a
-- legitimate, later, correct awaiting_clarification/reasoning/
-- generating_estimate reached by a retry against the same batch (the
-- whole point of migration 053's own scope_reasoning_completed_at
-- checkpoint: a retry against the same batch reuses it and gets further
-- than the attempt that stalled). This is a real modelling problem, not
-- a data anomaly or expected behaviour -- confirmed by reading the source,
-- not inferred from the mismatch alone.
--
-- Fix: only apply the stalled override when stalled_at is STRICTLY MORE
-- RECENT than every real-progress signal already available to the
-- function (a tie counts as progress, not stall, so a same-instant write
-- race never gets stuck labelled stalled) --
-- document_processing_jobs activity, the batch's own
-- scope_reasoning_completed_at, the most recent clarifying_questions
-- activity for the job, and quote creation. updated_at alone is NOT a
-- sufficient signal (confirmed: the scope_reasoning_completed_at write in
-- index.ts does not also bump document_processing_batches.updated_at), so
-- this compares stalled_at against the same broader progress signals the
-- function already gathers plus one addition (latest clarifying_questions
-- activity), not a schema change -- no new column needed.
--
-- Deliberately conservative: if a batch stalls again with NO further
-- progress afterward, "stalled" still correctly applies and still
-- overrides the structural status -- that path is unchanged. Only a
-- batch that has genuinely moved forward since its last recorded stall
-- stops being mislabeled.
-- ============================================================

CREATE OR REPLACE FUNCTION derive_estimate_run_projection(p_batch_id uuid)
RETURNS estimate_run_projection AS $$
DECLARE
  v_batch          document_processing_batches%ROWTYPE;
  v_docs_total     integer;
  v_docs_processed integer;
  v_docs_failed    integer;
  v_blocking_open  integer;
  v_lock_held      boolean;
  v_status         text;
  v_stall_reason   text;
  v_failure_reason text;
  v_last_progress  timestamptz;
  v_latest_question_activity timestamptz;
  v_quote_created_at timestamptz;
  v_progress_since_stall timestamptz;
  v_result         estimate_run_projection;
BEGIN
  SELECT * INTO v_batch FROM document_processing_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*) FILTER (WHERE true),
         count(*) FILTER (WHERE status = 'completed'),
         count(*) FILTER (WHERE status = 'failed')
    INTO v_docs_total, v_docs_processed, v_docs_failed
    FROM document_processing_jobs
    WHERE parent_job_id = p_batch_id;

  SELECT count(*) INTO v_blocking_open
    FROM clarifying_questions
    WHERE job_id = v_batch.job_id AND blocking = true AND status = 'open';

  SELECT EXISTS(SELECT 1 FROM job_intake_locks WHERE job_id = v_batch.job_id)
    INTO v_lock_held;

  v_stall_reason := v_batch.stall_reason;
  v_failure_reason := NULL;

  IF v_batch.quote_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM quotes WHERE id = v_batch.quote_id AND status <> 'draft'
     ) THEN
    v_status := 'complete';
  ELSIF v_batch.status = 'failed' AND v_docs_processed = 0 THEN
    v_status := 'failed';
    v_failure_reason := 'all documents in this batch failed extraction';
  ELSIF v_blocking_open > 0 THEN
    v_status := 'awaiting_clarification';
  ELSIF v_batch.quote_id IS NOT NULL THEN
    v_status := 'generating_estimate';
  ELSIF v_batch.scope_reasoning_completed_at IS NOT NULL THEN
    v_status := 'generating_estimate';
  ELSIF v_batch.classification_triggered THEN
    v_status := 'reasoning';
  ELSIF v_batch.status IN ('completed', 'completed_with_failures') THEN
    v_status := 'classifying';
  ELSE
    v_status := 'extracting';
  END IF;

  v_last_progress := GREATEST(
    v_batch.updated_at,
    COALESCE((SELECT max(updated_at) FROM document_processing_jobs WHERE parent_job_id = p_batch_id), v_batch.updated_at)
  );

  -- stall_reason/stalled_at is written once and never cleared (see header
  -- comment) -- only honor it as a CURRENT stall if nothing that counts as
  -- real forward progress has happened since. clarifying_questions activity
  -- (a question being raised or answered) and quote creation are both real
  -- progress signals bailForWallClockBudget's own document_processing_jobs/
  -- updated_at check can't see on their own.
  SELECT max(GREATEST(created_at, COALESCE(answered_at, created_at)))
    INTO v_latest_question_activity
    FROM clarifying_questions
    WHERE job_id = v_batch.job_id;

  SELECT created_at INTO v_quote_created_at
    FROM quotes WHERE id = v_batch.quote_id;

  v_progress_since_stall := GREATEST(
    v_last_progress,
    COALESCE(v_batch.scope_reasoning_completed_at, v_last_progress),
    COALESCE(v_latest_question_activity, v_last_progress),
    COALESCE(v_quote_created_at, v_last_progress)
  );

  IF v_status NOT IN ('complete', 'failed')
     AND v_stall_reason IS NOT NULL
     AND v_batch.stalled_at IS NOT NULL
     AND v_batch.stalled_at > v_progress_since_stall THEN
    v_status := 'stalled';
  END IF;

  v_result.status := v_status;
  v_result.quote_id := v_batch.quote_id;
  v_result.documents_total := COALESCE(v_docs_total, 0);
  v_result.documents_processed := COALESCE(v_docs_processed, 0);
  v_result.documents_failed := COALESCE(v_docs_failed, 0);
  v_result.blocking_questions_open := v_blocking_open;
  v_result.lock_held := v_lock_held;
  -- Still surfaced for diagnostics even when not overriding status --
  -- "this batch stalled once, at reason X" remains useful context on a
  -- run that has since moved past it.
  v_result.stall_reason := v_stall_reason;
  v_result.failure_reason := v_failure_reason;
  v_result.last_progress_at := v_last_progress;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION derive_estimate_run_projection(uuid) IS
  'Pure, read-only derivation of what estimate_runs state a batch SHOULD have. stall_reason/stalled_at (migration 053) are write-once and never cleared by the pipeline, so they only override the structural status when stalled_at is STRICTLY more recent than every other real-progress signal available (document job activity, scope_reasoning_completed_at, clarifying_questions activity, quote creation) -- a batch that stalled once and later made genuine progress (or progressed at the same instant) is not mislabeled stalled. See migration 058 for the incident this fixes.';

NOTIFY pgrst, 'reload schema';
