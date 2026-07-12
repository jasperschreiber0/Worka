-- 008_job_context_fields.sql
-- Adds budget_estimate and scope_notes to jobs so multi-action extraction
-- can preserve builder context that arrives alongside a new_job action.
-- Both columns are nullable — existing jobs are unaffected.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS budget_estimate numeric,
  ADD COLUMN IF NOT EXISTS scope_notes     text;

COMMENT ON COLUMN jobs.budget_estimate IS 'Builder-stated budget hint from initial message, in AUD';
COMMENT ON COLUMN jobs.scope_notes     IS 'Free-text scope context extracted from builder message';
