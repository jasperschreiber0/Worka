-- 076_estimate_run_failure_visibility.sql
-- Fixes a real gap in derive_estimate_run_projection (migration 058) found
-- while auditing whether estimate_runs already satisfies "ensure failures
-- are visible" for the first real end-to-end validation run: the failed-
-- branch condition is `v_batch.status = 'failed' AND v_docs_processed = 0`.
-- That only ever catches the case where EVERY document in the batch failed
-- extraction — it does not catch a billing halt (haltForBilling,
-- smooth-responder/index.ts) or a Stage 3 failure-escalation trip
-- (record_stage3_failure, migration 059), both of which set
-- document_processing_batches.status = 'failed' AFTER extraction already
-- succeeded for some or all documents (v_docs_processed > 0). For exactly
-- those two failure modes — arguably the two most consequential, since
-- they represent real, non-recoverable stops mid-run rather than a bad PDF
-- — the projection falls through to 'reasoning'/'generating_estimate' and
-- STAYS there forever: reconcile_estimate_run (migration 057) only sets
-- estimate_runs.completed_at when status IN ('complete', 'failed'), so a
-- billing-halted run never gets a completed_at either, making it look like
-- an indefinitely in-progress run rather than the terminal failure it is.
--
-- Fix: widen the condition to any v_batch.status = 'failed', regardless of
-- how many documents were processed — document_processing_batches.status
-- is already the authoritative terminal-failure signal for a batch (the
-- only writer is smooth-responder's own fail(), called from every failure
-- path including the billing halt) and correctly stays 'running'/'pending'
-- for a batch that is genuinely still working. Also enrich failure_reason:
-- instead of always emitting the single generic "all documents in this
-- batch failed extraction" string, prefer the actual stored reason —
-- files.failure_reason (written by fail() with a specific, human-readable
-- message: "AI processing stopped: Anthropic account credit balance is too
-- low — ...", etc.) or, failing that, the Stage 3 failure-escalation
-- classification already persisted on the batch itself
-- (stage3_failure_classification/stage3_failure_count, migration 059) —
-- falling back to the old generic message only when neither is available.
--
-- No change to when/how a batch or file actually gets marked failed —
-- purely a read-only derivation enrichment, same rule this migration
-- series already established (058's own header: "no existing table,
-- function, or call site is modified in a way that changes runtime
-- behavior for the live pipeline" — true here too, since nothing yet reads
-- estimate_runs to make a decision, only to observe one).

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
  ELSIF v_batch.status = 'failed' THEN
    v_status := 'failed';

    -- Prefer the most specific, human-readable reason available. A file's
    -- own failure_reason (written by fail() with the actual cause — billing
    -- halt, AI failure classification cap, extraction failure) is the most
    -- specific; at most one or two files in a batch will have this set in
    -- practice (fail() writes it once, never clears it), so LIMIT 1 with a
    -- stable order is sufficient without needing a true recency column
    -- (files has no updated_at).
    SELECT f.failure_reason INTO v_failure_reason
    FROM files f
    WHERE f.processing_batch_id = p_batch_id AND f.failure_reason IS NOT NULL
    ORDER BY f.id
    LIMIT 1;

    IF v_failure_reason IS NULL AND v_batch.stage3_failure_classification IS NOT NULL THEN
      v_failure_reason := 'Stage 3 (scope reasoning) failed repeatedly: '
        || v_batch.stage3_failure_classification || ' ('
        || v_batch.stage3_failure_count || ' consecutive occurrence(s) for the same input)';
    END IF;

    IF v_failure_reason IS NULL THEN
      v_failure_reason := CASE
        WHEN v_docs_processed = 0 THEN 'all documents in this batch failed extraction'
        ELSE format('batch marked failed after %s of %s document(s) processed — no specific reason recorded on the batch or its files', v_docs_processed, v_docs_total)
      END;
    END IF;
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
  v_result.stall_reason := v_stall_reason;
  v_result.failure_reason := v_failure_reason;
  v_result.last_progress_at := v_last_progress;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION derive_estimate_run_projection(uuid) IS
  'Pure, read-only derivation of what estimate_runs state a batch SHOULD have. A batch is ''failed'' whenever document_processing_batches.status = ''failed'' (the authoritative terminal-failure signal, set only by smooth-responder''s fail()) regardless of how many documents were processed — widened in migration 076 from a narrower condition that missed billing halts and Stage 3 failure-escalation trips, both of which fail a batch AFTER some/all documents already extracted successfully. failure_reason prefers the most specific stored reason available (a file''s own failure_reason, then stage3_failure_classification, then a generic fallback). stall_reason/stalled_at (migration 053) are write-once and never cleared, so they only override the structural status when stalled_at is STRICTLY more recent than every other real-progress signal available (document job activity, scope_reasoning_completed_at, clarifying_questions activity, quote creation) -- see migration 058 for the incident that fixed.';

NOTIFY pgrst, 'reload schema';
