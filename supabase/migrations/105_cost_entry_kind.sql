-- Distinguish money already incurred from money committed but not yet incurred.
-- Existing entries remain incurred so this is backwards compatible.
ALTER TABLE job_cost_entries
  ADD COLUMN IF NOT EXISTS cost_kind text NOT NULL DEFAULT 'incurred'
  CHECK (cost_kind IN ('incurred', 'committed'));

CREATE INDEX IF NOT EXISTS job_cost_entries_job_kind_idx
  ON job_cost_entries(job_id, cost_kind, incurred_on DESC);
