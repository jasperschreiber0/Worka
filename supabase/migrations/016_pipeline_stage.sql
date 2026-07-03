-- 016_pipeline_stage.sql
-- Adds pipeline_stage (current processing stage for SSE polling) and
-- intake_result (complete event payload written by worker on success).

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS pipeline_stage text,
  ADD COLUMN IF NOT EXISTS intake_result  jsonb;
