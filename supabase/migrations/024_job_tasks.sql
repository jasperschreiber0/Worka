-- ============================================================
-- job_tasks
--
-- app/api/jobs/[jobId]/tasks/route.ts already queries/inserts/updates a
-- `job_tasks` table in its real-mode branch, but no migration ever created
-- it — every real (non-demo) call to this route would fail with
-- "relation does not exist". This adds the table the route code already
-- assumes.
-- ============================================================

CREATE TABLE job_tasks (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              uuid        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  builder_id          uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  description         text        NOT NULL,
  assigned_to         text,
  assigned_worker_id  uuid        REFERENCES workers(id) ON DELETE SET NULL,
  status              text        NOT NULL DEFAULT 'open'
                                  CHECK (status IN ('open', 'done')),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON job_tasks (job_id, created_at DESC);
CREATE INDEX ON job_tasks (assigned_worker_id) WHERE assigned_worker_id IS NOT NULL;

ALTER TABLE job_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "job_tasks_own_builder" ON job_tasks FOR ALL USING (builder_id = auth.uid());
