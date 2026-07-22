-- 065_files_created_at_index.sql
-- Production safety audit of the Phase 2 document-similarity report tool
-- (GET /api/admin/document-similarity-report). That route's job-selection
-- query, when no job_id is given, does:
--   SELECT job_id, created_at FROM files ORDER BY created_at DESC LIMIT 5000
-- with no WHERE clause — a platform-wide scan across every builder's
-- files. files already has indexes on (builder_id, intake_status),
-- (job_id), (upload_batch_id), and (ai_failure_count) — migrations 001,
-- 030, 042 — but nothing on created_at alone, so this ORDER BY ... LIMIT
-- has no index to satisfy it and forces Postgres to read and sort the
-- whole table as it grows. Purely additive — no behaviour change, no
-- impact on any write path or the estimating pipeline.

CREATE INDEX IF NOT EXISTS idx_files_created_at ON files (created_at DESC);

COMMENT ON INDEX idx_files_created_at IS
  'Supports GET /api/admin/document-similarity-report''s recency-ordered job-selection scan (ORDER BY created_at DESC LIMIT 5000, no job_id filter) without forcing a full-table sort. Not used by any write path or the estimating pipeline.';
