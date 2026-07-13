-- ============================================================
-- WorkA — Multi-document reasoning audit, P0/P1 schema changes
-- ============================================================
-- 1. job_intake_locks: at most one active smooth-responder run per job.
--    The audit found the only "already processing" guard was scoped to a
--    single file_id, so a second file uploaded to the same job while the
--    first was still mid-pipeline would start a fully concurrent second
--    run — a genuine lost-update race on scope_items, and an open window
--    for duplicate draft quotes / duplicate line items. Acquired
--    atomically (INSERT, PK conflict = locked) by the Next.js intake
--    routes before triggering the engine; released by the engine itself
--    in a try/finally so it clears on every exit path (success, failure,
--    or pausing for a blocking clarifying question).
-- 2. files.upload_batch_id: durably records which files were selected
--    together in one upload, so a failed-partway-through batch can be
--    retried without re-uploading (and duplicating) the files that
--    already succeeded.
-- 3. files.skipped_sibling_filenames / failed_sibling_filenames: the
--    engine already computes these (documents dropped for exceeding the
--    per-run byte budget, or that failed to load from storage) but only
--    ever surfaced them on total failure — a partially-skipped but
--    otherwise successful run gave no indication a document was missed.
-- 4. Unique constraints on quotes / quote_line_items: a backstop, not the
--    primary defense (the job lock is) — makes the duplicate-quote and
--    duplicate-line-item races the audit found impossible in principle,
--    not just unlikely in practice.
-- ============================================================

-- ─── Job-level intake lock ───

CREATE TABLE IF NOT EXISTS job_intake_locks (
  job_id      uuid        PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  file_id     uuid        NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  started_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE job_intake_locks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "job_intake_locks_own_builder" ON job_intake_locks
  FOR ALL USING (job_id IN (SELECT id FROM jobs WHERE builder_id = auth.uid()));

COMMENT ON TABLE job_intake_locks IS
  'One row per job with an in-flight smooth-responder run. Acquired via a plain INSERT (PK conflict = another run holds it); released by the engine in a try/finally. A row older than the engine''s own overall timeout is treated as stale and can be taken over, in case a run was killed before it could release.';

-- ─── Batch tracking + partial-skip diagnostics on files ───

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS upload_batch_id           uuid,
  ADD COLUMN IF NOT EXISTS skipped_sibling_filenames  text[],
  ADD COLUMN IF NOT EXISTS failed_sibling_filenames   text[];

CREATE INDEX IF NOT EXISTS files_upload_batch_idx ON files (upload_batch_id)
  WHERE upload_batch_id IS NOT NULL;

COMMENT ON COLUMN files.upload_batch_id IS
  'Correlates files selected together in one UploadPanel session — set client-side per batch, not per file. Lets a partially-failed batch retry without re-uploading files that already succeeded.';

-- ─── Backstop uniqueness the job lock should already make unreachable ───

CREATE UNIQUE INDEX IF NOT EXISTS quotes_one_open_draft_per_job
  ON quotes (job_id)
  WHERE status IN ('draft', 'pending_review');

CREATE UNIQUE INDEX IF NOT EXISTS quote_line_items_unique_per_quote
  ON quote_line_items (quote_id, trade_category_id, description);
