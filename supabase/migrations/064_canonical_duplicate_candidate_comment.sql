-- 064_canonical_duplicate_candidate_comment.sql
-- Phase 1 correctness fix: content_hash alone ("we have seen these bytes")
-- was being used as sufficient evidence to treat a file as a duplicate's
-- canonical original. It is not — hashing happens before extraction,
-- independent of whether Stage 1/2 classification ever succeeds, so a
-- file whose classification permanently failed (or hasn't run yet) still
-- has a content_hash on record. Without restricting candidates to
-- successfully, durably processed documents, a permanently-failed original
-- would silently poison every future identical re-upload: each one gets
-- marked a duplicate of a document that never contributed anything, and
-- the real content never reaches the estimator no matter how many times
-- it's re-uploaded.
--
-- The fix itself is application-level (document-worker/index.ts now also
-- queries project_documents.extraction_status = 'complete' and restricts
-- candidates via the new pure filterToCanonicalHashCandidates,
-- pipeline-logic.ts, unit-tested) — there is no new column or constraint
-- here, only documentation of the guarantee directly on the columns/index
-- it concerns, so a future reader of the schema alone (without reading
-- document-worker's source) still learns the limitation. Paired with a new
-- schema_assertions.sql check that validates the invariant holds against
-- live data, since it's a real, checkable cross-table condition even
-- though enforcing it is application-level, not a CHECK constraint.

COMMENT ON COLUMN files.content_hash IS
  'SHA-256 (hex) of the raw file bytes, computed once in document-worker/index.ts at the earliest point bytes are available server-side (right after the Storage download, before any extraction). Null when hashing failed (fail-safe — never blocks the upload) or for files uploaded before this migration. Deliberately not unique/global: two different jobs legitimately containing byte-identical files (e.g. the same boilerplate cover sheet) are not duplicates of each other — see the (job_id, content_hash) index below. IMPORTANT: content_hash alone only proves "we have seen these bytes" — it is populated regardless of whether extraction or classification ever succeeded for this file, so it is NOT sufficient on its own to identify a file as a valid duplicate-candidate original. Only files with a project_documents row at extraction_status = ''complete'' (migration 050) may serve as the canonical match for a re-upload — see filterToCanonicalHashCandidates in supabase/functions/smooth-responder/pipeline-logic.ts, applied in document-worker/index.ts before duplicate_of_file_id is ever set.';

COMMENT ON COLUMN files.duplicate_of_file_id IS
  'Set when this file''s content_hash matched an earlier file in the SAME job that was successfully, durably classified (project_documents.extraction_status = ''complete'' for that file — migration 050''s strongest existing signal of genuine success, checked via filterToCanonicalHashCandidates before this column is ever written). Deterministic, hash-only — no LLM judgement, no relation to project_documents.is_duplicate/is_superseded, which are a separate Stage-1-populated, per-batch concept. The duplicate file row is never deleted — this column is the audit trail. Extraction is skipped for a file with this set; its content never reaches Claude (see loadAllFromExtractionResults in smooth-responder/index.ts). A file whose match target never reached extraction_status = ''complete'' (failed, or still processing) is NOT marked a duplicate and is allowed through extraction normally, so a permanently-failed original can never suppress its own correct re-upload.';

COMMENT ON INDEX idx_files_job_content_hash IS
  'Scoped to (job_id, content_hash) — duplicate matching never crosses jobs. NOTE: this index alone does not guarantee a matched row is a valid canonical original — it only proves the bytes were seen before. document-worker/index.ts additionally restricts candidates to files with project_documents.extraction_status = ''complete'' before treating any match as real; see files.content_hash''s own comment.';
