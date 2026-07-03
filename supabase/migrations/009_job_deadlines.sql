-- Migration 009: deadline fields on jobs
-- Persists builder-stated deadlines so morning brief can surface them
-- and the job panel can show what's coming up.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS quote_deadline  date,
  ADD COLUMN IF NOT EXISTS client_deadline date;

COMMENT ON COLUMN jobs.quote_deadline  IS 'Builder-stated deadline to deliver quote to client (e.g. "need pricing by Friday")';
COMMENT ON COLUMN jobs.client_deadline IS 'Client-stated hard deadline (e.g. council approval date, move-in date)';

CREATE INDEX IF NOT EXISTS idx_jobs_quote_deadline
  ON jobs(quote_deadline)
  WHERE quote_deadline IS NOT NULL;
