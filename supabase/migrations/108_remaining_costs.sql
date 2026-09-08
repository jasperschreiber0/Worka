-- Remaining allowances cover work not already incurred or committed.
ALTER TABLE job_cost_entries DROP CONSTRAINT IF EXISTS job_cost_entries_cost_kind_check;
ALTER TABLE job_cost_entries ADD CONSTRAINT job_cost_entries_cost_kind_check
  CHECK (cost_kind IN ('incurred', 'committed', 'remaining'));
