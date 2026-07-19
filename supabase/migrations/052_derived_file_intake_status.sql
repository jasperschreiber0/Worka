-- 052_derived_file_intake_status.sql
-- Redesigns ownership of files.intake_status for files that go through the
-- document-processing queue (migration 034 onward). It was never a real
-- per-file state machine for sibling files in a multi-file upload — only
-- the PRIMARY file (the one whose id the upload's SSE session used) was
-- ever written to, at every one of its four transition points
-- (createDocumentProcessingBatch, document-worker's caller never wrote it
-- at all, smooth-responder's fail()/needs_info/success paths — all four
-- scoped `.eq('id', fileId)` to the primary only). Every sibling file sat
-- at 'uploaded' forever, regardless of real outcome — this is what broke
-- the intake-recovery cron's stuck-classification discovery (it filtered
-- on files.intake_status = 'processing', which only the primary could ever
-- be) and, separately, produced permanently-stale "N plans uploaded but
-- not yet processed" messaging in JobSnapshotPanel's risk list and chat's
-- review_assumptions handler for every completed multi-file job.
--
-- The actual per-document truth already exists and is already correct:
--   - document_processing_jobs.status — per-document EXTRACTION outcome
--     (migration 034), independently claimed/retried per file.
--   - project_documents.extraction_status — per-document CLASSIFICATION
--     outcome, atomic with its project_facts (migration 050).
-- files.intake_status was being written as if IT were a third independent
-- truth source, from four scattered call sites that each only knew about
-- one file. This migration does not add a fourth — it makes
-- files.intake_status a pure, mechanically-recomputed PROJECTION of the
-- two real truth tables above, following the same "cached view, never
-- authoritative, recomputed and overwritten" pattern this codebase already
-- uses for jobs.knowledge_confidence (migration 035).

CREATE INDEX IF NOT EXISTS document_processing_jobs_document_id_idx
  ON document_processing_jobs (document_id, created_at DESC);

-- ─── recompute_file_intake_status ───────────────────────────────────────────
-- Derives one file's intake_status from its own document_processing_jobs
-- outcome and (once that document's own extraction succeeded) the batch it
-- belongs to — never from any OTHER file's row. This is what makes a
-- file's status individually accurate even inside a batch with mixed
-- outcomes: one genuinely-unreadable sibling correctly shows 'failed'
-- while the other nine, whose content made it into the quote, correctly
-- show 'extracted' — where the previous ad hoc writes gave every non-
-- primary file the same frozen 'uploaded' regardless of any of this.
--
-- Priority, evaluated per this file's own latest document_processing_jobs
-- row (there can be at most one non-terminal row per file at a time; a
-- file already 'complete' in project_documents is excluded from future
-- batch planning by migration 050's own history check, so "latest by
-- created_at" is unambiguous):
--   1. this file's own job failed                    -> 'failed'
--   2. this file's own job still pending/running      -> 'processing'
--   3. this file's own job completed, then look at the RUN it was part of:
--      a. batch reached Stage 6 (quote_id set)         -> 'extracted'
--      b. an open blocking question is pausing the run
--         AND classification has already started        -> 'needs_info'
--      c. the batch died later (e.g. a billing halt)    -> 'failed'
--      d. otherwise still reasoning                     -> 'processing'
--   4. no document_processing_jobs row exists at all for this file
--      (never entered the queue model — e.g. the legacy direct-invocation
--      path) -> leave untouched (NULL return, no write)
CREATE OR REPLACE FUNCTION recompute_file_intake_status(p_file_id uuid)
RETURNS text AS $$
DECLARE
  v_job document_processing_jobs%ROWTYPE;
  v_batch document_processing_batches%ROWTYPE;
  v_needs_info boolean;
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
    SELECT EXISTS (
      SELECT 1 FROM clarifying_questions
      WHERE job_id = v_batch.job_id AND blocking = true AND status = 'open'
    ) INTO v_needs_info;

    v_new_status := CASE
      WHEN v_batch.quote_id IS NOT NULL THEN 'extracted'
      WHEN v_needs_info AND v_batch.classification_triggered THEN 'needs_info'
      WHEN v_batch.status = 'failed' THEN 'failed'
      ELSE 'processing'
    END;
  END IF;

  UPDATE files SET intake_status = v_new_status WHERE id = p_file_id;
  RETURN v_new_status;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION recompute_file_intake_status IS
  'Derives and writes one file''s intake_status from document_processing_jobs (this file''s own extraction outcome) and document_processing_batches (the run it was part of) — the single writer of files.intake_status for files that went through the document-processing queue. Never authoritative itself; recomputed and overwritten from the two real truth tables (document_processing_jobs, project_documents-backed batch outcome) every time it is called. Returns NULL (no write) for a file that never entered the queue model.';

-- ─── recompute_batch_file_intake_statuses ───────────────────────────────────
-- Convenience wrapper for call sites that just finished/failed an entire
-- batch (createDocumentProcessingBatch at creation, smooth-responder at
-- every terminal write) — applies the same derivation to every file in the
-- batch in one call instead of the caller looping document ids itself.
CREATE OR REPLACE FUNCTION recompute_batch_file_intake_statuses(p_batch_id uuid)
RETURNS void AS $$
BEGIN
  PERFORM recompute_file_intake_status(document_id)
  FROM document_processing_jobs
  WHERE parent_job_id = p_batch_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION recompute_batch_file_intake_statuses IS
  'Recomputes files.intake_status for every file in a document_processing_batches batch via recompute_file_intake_status — called whenever a batch reaches or changes a terminal outcome, so every file in the run (not just its primary/anchor file) gets an accurate status, not only the one file whose id happened to trigger the write.';

-- Superseded by find_stuck_batches_needing_classification_retry below —
-- app/api/cron/intake-recovery/route.ts is updated in this same change to
-- call the replacement, so dropping this immediately (rather than leaving
-- it as unreferenced dead code) is safe.
DROP FUNCTION IF EXISTS find_stuck_files_needing_classification_retry(interval);

-- ─── find_stuck_batches_needing_classification_retry ───────────────────────
-- Replaces find_stuck_files_needing_classification_retry (migration 037).
-- The old version joined files ON files.processing_batch_id = f.processing_batch_id
-- and filtered files.intake_status = 'processing' — both fields that were
-- ever only populated for a batch's PRIMARY file, so this discovery query
-- could structurally never surface a batch whose primary file itself
-- wasn't the one left stuck. document_processing_batches already carries
-- every field this needs natively (job_id, builder_id) — there was never a
-- real reason to route this through files at all.
CREATE OR REPLACE FUNCTION find_stuck_batches_needing_classification_retry(p_grace interval DEFAULT interval '3 minutes')
RETURNS TABLE(batch_id uuid, job_id uuid, builder_id uuid, primary_file_id uuid) AS $$
  SELECT b.id, b.job_id, b.builder_id, b.primary_file_id
  FROM document_processing_batches b
  WHERE b.status IN ('completed', 'completed_with_failures', 'failed')
    AND b.classification_triggered = true
    AND b.updated_at < now() - p_grace
    AND NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = b.job_id);
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION find_stuck_batches_needing_classification_retry IS
  'Batches whose document-processing finished and flipped classification_triggered, but no job_intake_locks row ever appeared for the job — evidence the triggerClassification fetch to smooth-responder was itself lost. Batch-keyed (not primary-file-keyed, unlike the migration 037 function this replaces) so a job with multiple stuck batches surfaces all of them, and so this no longer depends on files.intake_status/processing_batch_id ever being populated for a specific file.';

-- ─── One-time backfill for already-uploaded files ──────────────────────────
-- Corrects every file that has already gone through the queue model
-- (migration 034 onward) but was never a primary/anchor file for its
-- batch, so it never got a real files.intake_status write. Idempotent and
-- safe to run against live data — a pure re-derivation from
-- document_processing_jobs/document_processing_batches as they stand
-- today, not a blind flag flip (mirrors migration 050's own
-- evidence-based extraction_status backfill). A successfully-quoted job's
-- stale-looking siblings flip 'uploaded' -> 'extracted' immediately; a
-- genuinely-dead run's siblings flip to 'failed'. Files that never entered
-- the queue model are left untouched (recompute_file_intake_status returns
-- NULL for them).
DO $$
DECLARE
  v_file_id uuid;
BEGIN
  FOR v_file_id IN SELECT DISTINCT document_id FROM document_processing_jobs LOOP
    PERFORM recompute_file_intake_status(v_file_id);
  END LOOP;
END $$;
