-- 067_remove_needs_info_status.sql
-- Closes a gap left by the non-blocking-estimation change (migration 066):
-- recompute_file_intake_status (migration 052) could still derive
-- 'needs_info' for a file, even though smooth-responder itself no longer
-- pauses for a blocking clarifying question — Stage 6 always runs in the
-- same invocation now, producing a disclosed conservative assumption
-- instead of stopping.
--
-- Root cause, confirmed live: recompute_file_intake_status's v_needs_info
-- check is job-wide (`clarifying_questions WHERE job_id = ... AND
-- blocking = true AND status = 'open'`), not scoped to the CURRENT batch —
-- so a job with an already-open (still-unanswered, by design — see 066)
-- blocking question from an EARLIER run gets 'needs_info' recomputed for
-- any NEWLY-extracted file the moment document-worker finishes that
-- file's own Stage 1/2 extraction and the new batch's classification_
-- triggered flips true (document-worker/index.ts:539) — well before the
-- CURRENT run's own Stage 3-6 has even finished, or sometimes even
-- started. The SSE poller (app/api/intake/[fileId]/route.ts) treats any
-- sighting of 'needs_info' as terminal — it emits needs_clarification and
-- closes the stream immediately — so a builder mid-upload was shown the
-- old "answer before I estimate" screen even while a real run was already
-- in progress and about to produce a quote seconds later.
--
-- Fix: 'needs_info' is no longer a real waiting state under the
-- non-blocking pipeline, so recompute_file_intake_status simply stops
-- producing it. A file whose own extraction is done either already has a
-- quote (this batch reached Stage 6) -> 'extracted', or is still being
-- reasoned about -> 'processing', which will resolve to 'extracted' on
-- the next recompute once Stage 6 finishes (it always will, short of a
-- genuine can't-process-at-all failure). The clarifying_questions table
-- itself, and the assumptions it produces, are unaffected — only the
-- derived files.intake_status projection changes.

CREATE OR REPLACE FUNCTION recompute_file_intake_status(p_file_id uuid)
RETURNS text AS $$
DECLARE
  v_job document_processing_jobs%ROWTYPE;
  v_batch document_processing_batches%ROWTYPE;
  v_new_status text;
BEGIN
  SELECT * INTO v_job
  FROM document_processing_jobs
  WHERE document_id = p_file_id
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_batch FROM document_processing_batches WHERE id = v_job.parent_job_id;

  IF v_job.status = 'failed' THEN
    v_new_status := 'failed';
  ELSIF v_job.status IN ('pending', 'running') THEN
    v_new_status := 'processing';
  ELSE -- v_job.status = 'completed'
    v_new_status := CASE
      WHEN v_batch.quote_id IS NOT NULL THEN 'extracted'
      WHEN v_batch.status = 'failed' THEN 'failed'
      ELSE 'processing'
    END;
  END IF;

  UPDATE files SET intake_status = v_new_status WHERE id = p_file_id;
  RETURN v_new_status;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION recompute_file_intake_status IS
  'Derives and writes one file''s intake_status from document_processing_jobs (this file''s own extraction outcome) and document_processing_batches (the run it was part of) — the single writer of files.intake_status for files that went through the document-processing queue. Never authoritative itself; recomputed and overwritten from the two real truth tables every time it is called. Returns NULL (no write) for a file that never entered the queue model. As of migration 067, never derives ''needs_info'' — the pipeline no longer pauses on a blocking clarifying question (see 066_conservative_assumptions.sql), so a file with completed extraction is either ''extracted'' (its batch reached Stage 6) or ''processing'' (still reasoning, resolves to ''extracted'' once Stage 6 finishes).';

-- ─── One-time self-heal for any file already stuck at 'needs_info' ─────────
-- Same pattern as migration 052's own backfill: a pure re-derivation from
-- document_processing_jobs/document_processing_batches as they stand today,
-- not a blind flag flip. Fixes any job that was showing the stale
-- "answer before I estimate" screen at the moment this migration deploys.
DO $$
DECLARE
  v_file_id uuid;
BEGIN
  FOR v_file_id IN SELECT id FROM files WHERE intake_status = 'needs_info' LOOP
    PERFORM recompute_file_intake_status(v_file_id);
  END LOOP;
END $$;
