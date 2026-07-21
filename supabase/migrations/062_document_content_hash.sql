-- 062_document_content_hash.sql
-- Phase 1 of the document-identity production-safety roadmap (see the
-- gate-by-gate review that preceded this): deterministic, cross-session
-- duplicate detection by file content — Gate 1 of that lifecycle. No
-- change to what gets estimated: this only stops an already-seen file's
-- bytes from being re-extracted and re-sent to Claude a second time under
-- a new upload session; Stage 3 filtering, LLM-judged duplicate/superseded
-- detection (project_documents.is_duplicate/is_superseded, populated by
-- Stage 1 per-batch and left untouched here), and fact-merge behaviour
-- (mergeFacts) are all explicitly out of scope for this migration.
--
-- Deliberately targets the real `files` table, not a `documents` table —
-- this schema has no `documents` table; `files` (migration 001, with
-- upload_batch_id added in 030) is where every uploaded document already
-- lives, keyed by job_id.

ALTER TABLE files ADD COLUMN IF NOT EXISTS content_hash text;

COMMENT ON COLUMN files.content_hash IS
  'SHA-256 (hex) of the raw file bytes, computed once in document-worker/index.ts at the earliest point bytes are available server-side (right after the Storage download, before any extraction). Null when hashing failed (fail-safe — never blocks the upload) or for files uploaded before this migration. Deliberately not unique/global: two different jobs legitimately containing byte-identical files (e.g. the same boilerplate cover sheet) are not duplicates of each other — see the (job_id, content_hash) index below.';

ALTER TABLE files ADD COLUMN IF NOT EXISTS duplicate_of_file_id uuid REFERENCES files(id);

COMMENT ON COLUMN files.duplicate_of_file_id IS
  'Set when this file''s content_hash matched an earlier file in the SAME job (deterministic, hash-only — no LLM judgement, no relation to project_documents.is_duplicate/is_superseded, which are a separate Stage-1-populated, per-batch concept). The duplicate file row is never deleted — this column is the audit trail. Extraction is skipped for a file with this set; its content never reaches Claude (see loadAllFromExtractionResults in smooth-responder/index.ts).';

-- Scoped to (job_id, content_hash), not a bare content_hash index — the
-- question this answers is always "has THIS job already received this
-- file," matching the actual problem (a job's document/fact count
-- inflating across repeated re-uploads of the same test set), not
-- "has any builder, anywhere, ever uploaded this exact file."
CREATE INDEX IF NOT EXISTS idx_files_job_content_hash
  ON files (job_id, content_hash)
  WHERE content_hash IS NOT NULL;
