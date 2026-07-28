-- 080_fix_estimate_run_complete_status_stale_gates.sql
-- Root-cause fix found while driving one real residential project through
-- the live pipeline end-to-end: a project whose Stage 6 (Estimate
-- Generation) genuinely completed — quote created, line items priced, QA
-- run — never got builder_status set at all. estimate_runs.status stayed
-- 'awaiting_clarification' forever, so reconcile_estimate_run's
-- `IF v_proj.status IN ('complete', 'failed')` guard never ran
-- compute_builder_status, and enforce_estimate_deadlines was the only thing
-- that could ever finalize the run (a full 15-minute wait for a run that
-- was actually done in under 2 minutes).
--
-- derive_estimate_run_projection (migration 058, last redefined in 076)
-- gates 'complete' on two conditions that were correct under an EARLIER
-- pipeline design but are now stale:
--
--   1. `v_blocking_open > 0` short-circuits to 'awaiting_clarification'
--      before the quote_id check is ever reached. This matched the
--      documented (see CLAUDE.md's "Reasoning-First Estimating Engine")
--      original behavior where a blocking clarifying question paused the
--      pipeline before Stage 6. That is no longer how smooth-responder
--      works: see supabase/functions/smooth-responder/index.ts's own
--      comment directly above its blocking-question handling ("Non-blocking
--      estimation: a blocking question is persisted (audit trail...) but no
--      longer stops the pipeline here — Stage 6 below always runs, using an
--      explicit, disclosed assumption in place of the missing answer...
--      WorkA should always produce an estimate on the first run"). Stage 6
--      runs and creates a quote REGARDLESS of open blocking questions, so a
--      genuinely complete run with an open blocking question was
--      misreported as still waiting on one.
--
--   2. `EXISTS (SELECT 1 FROM quotes WHERE id = v_batch.quote_id AND status
--      <> 'draft')` requires the quote to have already left its initial
--      lifecycle state. Every quote Stage 6 creates starts in 'draft' (see
--      CLAUDE.md's quote state machine: draft -> pending_review -> sent ->
--      approved | rejected) and only advances once a human builder resolves
--      assumptions via the assumptions UI — a step wholly outside the
--      estimating pipeline this projection is meant to track. In practice
--      this meant NO freshly generated estimate could ever be reported
--      'complete' by this projection, regardless of how correct or
--      warning-free it was.
--
-- Confirmed live: a real kitchen+bathroom renovation project reached
-- Stage 6 (quote b1b3d827-..., 52 line items, 84.62% price coverage, QA
-- report populated) with one open blocking clarifying question (asbestos
-- testing) and its quote sitting in 'draft' — both individually enough to
-- keep estimate_runs stuck at 'awaiting_clarification' with
-- builder_status left NULL indefinitely.
--
-- Fix: a batch is 'complete' the moment smooth-responder has actually
-- produced a quote (`v_batch.quote_id IS NOT NULL`) — that is the real,
-- authoritative "Stage 6 finished" signal already used elsewhere in this
-- same function (the pre-existing 'generating_estimate' fallback branches
-- already treated quote_id-not-null as meaningful progress). Blocking
-- clarifying questions and quote lifecycle status are no longer part of
-- the completion gate; blocking_questions_open is still recorded on the
-- estimate_runs row (v_result.blocking_questions_open, unchanged) purely
-- as an informational/audit field, same as before. No change to
-- compute_builder_status (migration 079) — it already derives its verdict
-- from coverage/missing-trades/unresolved-assumptions independent of quote
-- lifecycle status or clarifying-question state, so it needed no fix.

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

  -- 'complete' now depends only on whether Stage 6 actually produced a
  -- quote — not on quote lifecycle status (draft is the normal, expected
  -- state of every freshly generated quote) and not on open blocking
  -- clarifying questions (smooth-responder always proceeds past those with
  -- a disclosed conservative assumption; see this migration's header).
  IF v_batch.quote_id IS NOT NULL THEN
    v_status := 'complete';
  ELSIF v_batch.status = 'failed' THEN
    v_status := 'failed';

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
  'Pure, read-only derivation of what estimate_runs state a batch SHOULD have. A batch is ''complete'' as soon as Stage 6 has produced a quote (quote_id IS NOT NULL) — migration 080 removed two stale gates (requiring quote status <> draft, and blocking_open = 0) that predated smooth-responder''s current always-proceed-with-a-disclosed-assumption design and made ''complete'' unreachable for a normal freshly-generated estimate. A batch is ''failed'' whenever document_processing_batches.status = ''failed'' regardless of how many documents were processed (migration 076). failure_reason prefers the most specific stored reason available. stall_reason/stalled_at are write-once and never cleared, so they only override the structural status when stalled_at is strictly more recent than every other real-progress signal available.';

NOTIFY pgrst, 'reload schema';
