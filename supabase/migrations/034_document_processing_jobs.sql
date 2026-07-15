-- ============================================================
-- WorkA — Document processing queue/worker model
-- ============================================================
-- Context: the previous fix (migration 033) made a CPU-time kill during PDF
-- text extraction recoverable faster, but didn't remove the failure mode
-- itself — every document in one upload still shares a single
-- smooth-responder invocation's 2000ms CPU budget, so one expensive PDF can
-- still exhaust it and take the whole batch down with it.
--
-- This migration moves extraction out of that shared invocation entirely.
-- Each document is now its own row in document_processing_jobs, claimed and
-- processed by its own document-worker Edge Function invocation — a fresh
-- HTTP request, a fresh 2000ms CPU budget, per Supabase's own per-request
-- metering. A single problematic PDF can still exhaust ITS OWN budget and
-- die, but that death is scoped to one row, not the whole batch: the
-- surviving documents' jobs are untouched, and the failed one retries
-- independently (see the retry_or_fail_document_job function below).
--
-- document_processing_batches is the parent entity: one row per upload
-- batch (whatever the primary file's trigger created), aggregating child
-- job outcomes into a single status and gating exactly one trigger of the
-- downstream classification/estimate stage (Stage 1/2 onward, still a
-- batched Claude call for cost reasons — see recompute_parent_batch_status
-- for how the "trigger exactly once" race is closed transactionally).
-- ============================================================

CREATE TABLE IF NOT EXISTS document_processing_batches (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                   uuid        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  builder_id               uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  primary_file_id          uuid        NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  status                   text        NOT NULL DEFAULT 'pending'
                                        CHECK (status IN ('pending', 'running', 'completed', 'completed_with_failures', 'failed')),
  classification_triggered boolean     NOT NULL DEFAULT false,
  quote_id                 uuid        REFERENCES quotes(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_processing_jobs (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_job_id  uuid        NOT NULL REFERENCES document_processing_batches(id) ON DELETE CASCADE,
  document_id    uuid        NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  status         text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempts       integer     NOT NULL DEFAULT 0,
  error_message  text,
  -- Retry backoff scheduling (30s after attempt 1, 2min after attempt 2 —
  -- see retry_or_fail_document_job). A job is only claimable once
  -- run_after <= now(), so a scheduled retry doesn't get picked up early.
  run_after      timestamptz NOT NULL DEFAULT now(),
  locked_at      timestamptz,
  started_at     timestamptz,
  completed_at   timestamptz,
  -- Extraction output (blockType/text/pageCount/durationMs/hasUsableText)
  -- persisted here so the classification stage can build its Claude message
  -- content without re-downloading or re-parsing anything for text-path
  -- documents. Deliberately never holds raw file bytes (jsonb is the wrong
  -- place for multi-MB base64, and re-download is plain I/O, not the
  -- CPU-bound parsing step this whole model exists to isolate) — a
  -- vision-path document's binary is re-fetched from storage at
  -- classification time instead.
  result         jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_processing_jobs_status_idx ON document_processing_jobs (status);
CREATE INDEX IF NOT EXISTS document_processing_jobs_parent_job_id_idx ON document_processing_jobs (parent_job_id);
CREATE INDEX IF NOT EXISTS document_processing_jobs_locked_at_idx ON document_processing_jobs (locked_at);
-- Matches claim_next_document_job's WHERE clause exactly, so the atomic
-- claim below stays a single index scan even with many batches in flight.
CREATE INDEX IF NOT EXISTS document_processing_jobs_claim_idx
  ON document_processing_jobs (parent_job_id, run_after)
  WHERE status = 'pending';

ALTER TABLE document_processing_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_processing_jobs    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_processing_batches_own_builder" ON document_processing_batches
  FOR ALL USING (builder_id = auth.uid());

CREATE POLICY "document_processing_jobs_own_builder" ON document_processing_jobs
  FOR ALL USING (parent_job_id IN (SELECT id FROM document_processing_batches WHERE builder_id = auth.uid()));

-- ─── recompute_parent_batch_status ─────────────────────────────────────────
-- Shared by complete_document_job and retry_or_fail_document_job (only on
-- a job's FINAL failure, not an in-progress retry) — recomputes the parent
-- batch's aggregate status from its children and, exactly once per batch,
-- flips classification_triggered false->true the moment every child has
-- reached a terminal state (completed or failed). That flip is done inside
-- the same UPDATE that's guarded by "AND classification_triggered = false",
-- so if two worker chains finish their last respective jobs at nearly the
-- same instant, only one of them will see should_trigger_classification =
-- true back — Postgres serializes the two UPDATEs, and the second one's
-- WHERE clause simply matches zero rows. This is what makes "trigger
-- Stage 1/2 exactly once per batch" safe without an application-level lock.
CREATE OR REPLACE FUNCTION recompute_parent_batch_status(p_parent_job_id uuid)
RETURNS TABLE(new_status text, should_trigger_classification boolean) AS $$
DECLARE
  v_pending_or_running int;
  v_completed int;
  v_failed int;
  v_status text;
  v_triggered boolean := false;
BEGIN
  SELECT
    count(*) FILTER (WHERE status IN ('pending', 'running')),
    count(*) FILTER (WHERE status = 'completed'),
    count(*) FILTER (WHERE status = 'failed')
  INTO v_pending_or_running, v_completed, v_failed
  FROM document_processing_jobs
  WHERE parent_job_id = p_parent_job_id;

  IF v_pending_or_running > 0 THEN
    v_status := 'running';
  ELSIF v_failed > 0 AND v_completed > 0 THEN
    v_status := 'completed_with_failures';
  ELSIF v_failed > 0 THEN
    v_status := 'failed';
  ELSE
    v_status := 'completed';
  END IF;

  IF v_status IN ('completed', 'completed_with_failures', 'failed') THEN
    UPDATE document_processing_batches
    SET status = v_status, updated_at = now(), classification_triggered = true
    WHERE id = p_parent_job_id AND classification_triggered = false;
    v_triggered := FOUND;
  ELSE
    UPDATE document_processing_batches SET status = v_status, updated_at = now() WHERE id = p_parent_job_id;
  END IF;

  RETURN QUERY SELECT v_status, v_triggered;
END;
$$ LANGUAGE plpgsql;

-- ─── claim_next_document_job ───────────────────────────────────────────────
-- Atomic claim: FOR UPDATE SKIP LOCKED means two document-worker invocations
-- racing this same statement for the same parent_job_id can never both
-- return the same row — the second one's SELECT simply skips the row the
-- first has already locked and finds the next pending one (or none). This
-- is the mechanism that makes "two workers cannot claim the same job" true
-- at the database layer, not something enforceable from application code.
CREATE OR REPLACE FUNCTION claim_next_document_job(p_parent_job_id uuid)
RETURNS SETOF document_processing_jobs AS $$
BEGIN
  RETURN QUERY
  UPDATE document_processing_jobs
  SET status = 'running', locked_at = now(), started_at = COALESCE(started_at, now()), updated_at = now()
  WHERE id = (
    SELECT id FROM document_processing_jobs
    WHERE parent_job_id = p_parent_job_id AND status = 'pending' AND run_after <= now()
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
END;
$$ LANGUAGE plpgsql;

-- ─── complete_document_job ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION complete_document_job(p_job_id uuid, p_result jsonb)
RETURNS TABLE(new_status text, should_trigger_classification boolean) AS $$
DECLARE
  v_parent_job_id uuid;
BEGIN
  UPDATE document_processing_jobs
  SET status = 'completed', result = p_result, completed_at = now(), updated_at = now()
  WHERE id = p_job_id
  RETURNING parent_job_id INTO v_parent_job_id;

  RETURN QUERY SELECT * FROM recompute_parent_batch_status(v_parent_job_id);
END;
$$ LANGUAGE plpgsql;

-- ─── retry_or_fail_document_job ─────────────────────────────────────────────
-- Attempt 1 runs immediately (no delay — a job starts claimable at
-- run_after = now() from insert). On failure of attempt N, attempts becomes
-- N+1: if that's still under p_max_attempts, the job goes back to pending
-- with a backoff delay (30s after the 1st failure, 2min after the 2nd) so
-- claim_next_document_job won't pick it up again immediately; once
-- attempts reaches p_max_attempts (3rd failure), it's marked failed for
-- good and the parent batch aggregate is recomputed exactly like a
-- successful completion — a permanently-failed document is just as
-- "terminal" as a completed one for the purposes of deciding when the
-- batch is done and classification should run.
CREATE OR REPLACE FUNCTION retry_or_fail_document_job(p_job_id uuid, p_error text, p_max_attempts int DEFAULT 3)
RETURNS TABLE(new_status text, should_trigger_classification boolean, next_run_after timestamptz) AS $$
DECLARE
  v_parent_job_id uuid;
  v_attempts int;
  v_delay interval;
BEGIN
  SELECT parent_job_id, attempts + 1 INTO v_parent_job_id, v_attempts
  FROM document_processing_jobs WHERE id = p_job_id;

  IF v_attempts >= p_max_attempts THEN
    UPDATE document_processing_jobs
    SET status = 'failed', attempts = v_attempts, error_message = p_error, locked_at = NULL, updated_at = now()
    WHERE id = p_job_id;

    RETURN QUERY
      SELECT r.new_status, r.should_trigger_classification, NULL::timestamptz
      FROM recompute_parent_batch_status(v_parent_job_id) r;
  ELSE
    v_delay := CASE WHEN v_attempts = 1 THEN interval '30 seconds' ELSE interval '2 minutes' END;
    UPDATE document_processing_jobs
    SET status = 'pending', attempts = v_attempts, error_message = p_error,
        run_after = now() + v_delay, locked_at = NULL, updated_at = now()
    WHERE id = p_job_id;

    RETURN QUERY SELECT 'running'::text, false, (now() + v_delay);
  END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE document_processing_batches IS
  'One row per upload batch. Aggregate status derived from its document_processing_jobs children by recompute_parent_batch_status. classification_triggered is flipped exactly once, transactionally, the moment every child reaches a terminal state — see that function''s comment.';

COMMENT ON TABLE document_processing_jobs IS
  'One row per document to extract. Claimed via claim_next_document_job (FOR UPDATE SKIP LOCKED — real DB-level mutual exclusion, not an application lock). Each claim is processed by its own document-worker Edge Function invocation, giving that single document a fresh, isolated Supabase CPU-time budget instead of sharing one with every other document in the batch.';

-- ─── files.processing_batch_id ──────────────────────────────────────────────
-- Lets the Next.js SSE poller (app/api/intake/[fileId]/route.ts) recover
-- which document_processing_batches row belongs to a given upload across
-- reconnects, using the same primary-file anchor everything else already
-- polls against — no new query-string parameter needed on the EventSource
-- URL.
ALTER TABLE files
  ADD COLUMN IF NOT EXISTS processing_batch_id uuid REFERENCES document_processing_batches(id);
