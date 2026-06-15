-- 015_intake_diagnostics.sql
-- Adds failure-stage tracking columns to the files table so every intake
-- attempt records exactly where and why it failed. These columns are written
-- by the GET /api/intake/[fileId] pipeline and can be queried from the admin
-- dashboard or Supabase Studio to debug extraction issues.

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS failure_stage        text,
  ADD COLUMN IF NOT EXISTS failure_reason       text,
  ADD COLUMN IF NOT EXISTS extracted_text_length integer,
  ADD COLUMN IF NOT EXISTS page_count            integer,
  ADD COLUMN IF NOT EXISTS line_item_count       integer,
  ADD COLUMN IF NOT EXISTS processing_time_ms    integer;

-- Index for admin queries: "show me all files that failed at a specific stage"
CREATE INDEX IF NOT EXISTS files_failure_stage_idx ON files (failure_stage)
  WHERE failure_stage IS NOT NULL;
