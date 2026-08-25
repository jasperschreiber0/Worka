-- 100_project_memory_job_id_full_unique_index.sql
-- Fixes a production-confirmed bug found by the Job Closeout v1 E2E
-- (scripts/run-job-closeout-e2e.mjs): POST /api/estimation/reconcile's
-- project_memory upsert (onConflict: 'job_id') was failing on EVERY call
-- with Postgres error 42P10 — "there is no unique or exclusion constraint
-- matching the ON CONFLICT specification" — while the route returned
-- ok:true anyway (a separate bug, fixed in the route itself alongside this
-- migration, not here).
--
-- Root cause: the only unique index on project_memory.job_id
-- (project_memory_job_id_idx, migration 011) is PARTIAL:
--   create unique index ... on project_memory(job_id) where job_id is not null
-- Postgres cannot infer a partial index as an ON CONFLICT (job_id) arbiter
-- from a plain `ON CONFLICT (job_id)` clause with no matching WHERE — the
-- upsert has never actually been able to succeed since this route was
-- written; nothing ever called it in production before Job Closeout v1
-- gave it a reachable UI trigger, which is why this went unnoticed.
--
-- Fix: replace the partial index with a full (non-partial) unique index on
-- the same column. This is NOT a behaviour change — a standard unique
-- index already treats NULL as distinct from every other NULL, so multiple
-- project_memory rows with job_id = NULL remain allowed, identical to the
-- partial index's actual effect for non-null values. The only difference
-- is that a full unique index IS a valid ON CONFLICT (job_id) arbiter.
--
-- No data migration needed: the partial index already guaranteed at most
-- one row per non-null job_id, so no existing rows can violate the new,
-- non-partial version of that same guarantee.

DROP INDEX IF EXISTS project_memory_job_id_idx;

CREATE UNIQUE INDEX IF NOT EXISTS project_memory_job_id_idx
  ON public.project_memory(job_id);
