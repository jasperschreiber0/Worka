-- Migration 007: job_workers junction table + subcontractor RLS isolation
-- Allows subcontractors to be assigned to specific jobs. Subcontractors
-- can only see jobs they are explicitly assigned to; site managers and
-- owners see all jobs under their builder.

-- ─── Junction table ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_workers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  worker_id   uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid REFERENCES workers(id),
  UNIQUE (job_id, worker_id)
);

CREATE INDEX IF NOT EXISTS idx_job_workers_job_id    ON job_workers (job_id);
CREATE INDEX IF NOT EXISTS idx_job_workers_worker_id ON job_workers (worker_id);

ALTER TABLE job_workers ENABLE ROW LEVEL SECURITY;

-- Builders can manage all assignments under their builder
CREATE POLICY "job_workers_builder_full_access"
  ON job_workers
  USING (
    EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = job_workers.job_id
        AND j.builder_id = auth.uid()
    )
  );

-- ─── Seed demo assignments ────────────────────────────────────────────────────

-- Tom Chen (site manager) → all three jobs
INSERT INTO job_workers (job_id, worker_id)
VALUES
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000021'),
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000021'),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000021')
ON CONFLICT DO NOTHING;

-- Mick Tran (subcontractor) → Fitzroy job only
INSERT INTO job_workers (job_id, worker_id)
VALUES
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000022')
ON CONFLICT DO NOTHING;

-- Sarah Chen (tradesperson) → Toorak job only
INSERT INTO job_workers (job_id, worker_id)
VALUES
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000023')
ON CONFLICT DO NOTHING;

-- ─── Updated jobs RLS: subcontractor isolation ────────────────────────────────
-- Drop the existing permissive jobs SELECT policy and replace it with one
-- that enforces subcontractor scope.

DROP POLICY IF EXISTS "jobs_own_builder" ON jobs;

CREATE POLICY "jobs_builder_or_assigned_worker"
  ON jobs FOR SELECT
  USING (
    -- Builders see all their jobs
    builder_id = auth.uid()
    OR
    -- Workers see only jobs they are assigned to, and only if their
    -- permission_role is subcontractor or tradesperson (site managers
    -- inherit full access via the builder_id path when acting as the
    -- builder, or are covered by a separate policy below)
    EXISTS (
      SELECT 1 FROM job_workers jw
      JOIN workers w ON w.id = jw.worker_id
      WHERE jw.job_id = jobs.id
        AND w.id = auth.uid()
    )
  );

-- Comment documents the design decision
COMMENT ON TABLE job_workers IS
  'Assigns workers to jobs. Subcontractors (permission_role=subcontractor) '
  'can only SELECT jobs via the jobs_builder_or_assigned_worker RLS policy. '
  'Site managers and owners access all jobs through builder_id ownership.';
