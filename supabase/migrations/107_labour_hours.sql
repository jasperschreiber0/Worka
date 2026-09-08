-- Tier 3: simple labour hours captured against a job and worker.
CREATE TABLE IF NOT EXISTS job_labour_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), builder_id uuid NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, worker_id uuid REFERENCES workers(id) ON DELETE SET NULL,
  work_date date NOT NULL DEFAULT CURRENT_DATE, hours numeric(8,2) NOT NULL CHECK (hours > 0 AND hours <= 24), note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE job_labour_hours ENABLE ROW LEVEL SECURITY;
CREATE POLICY "job_labour_hours_own_builder" ON job_labour_hours FOR ALL USING (builder_id = auth.uid());
CREATE INDEX IF NOT EXISTS job_labour_hours_job_date_idx ON job_labour_hours(job_id, work_date DESC);
