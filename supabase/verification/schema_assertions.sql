-- ============================================================
-- WorkA — post-migration schema assertions
-- ============================================================
-- Automates the "database verification" section of the manual production
-- runbook for the document-processing-queue / project-memory feature set
-- (migrations 026, 030, 033-036). Run this immediately after `supabase db
-- push` (see .github/workflows/supabase-migrate.yml) — every assertion
-- RAISEs EXCEPTION on failure, so the workflow step fails loudly instead of
-- a missing table/column/index/policy silently reaching production and only
-- being noticed the next time something reads from it.
--
-- Scope: deliberately limited to the schema this session's work actually
-- touched (the document processing queue, its locking/heartbeat, and the
-- persisted project-knowledge columns) rather than every table in the
-- 36-migration history — asserting the whole schema wasn't asked for and
-- would need to be kept in lockstep with every future migration regardless
-- of whether it relates to this feature area.
--
-- Idempotent and read-only: safe to run repeatedly, never mutates data.
-- Fails fast: the first failing assertion aborts the script (each is its
-- own DO block, so psql -v ON_ERROR_STOP=1 — or a bare `psql -f` on
-- Postgres's default error handling for a script, which already stops on
-- error — will surface exactly which check failed and why).
-- ============================================================

\set ON_ERROR_STOP on

-- ─── helper: assert a condition, raising with a clear message ─────────────
-- Created in pg_temp so it never leaks into the permanent public schema —
-- it exists only for the lifetime of this psql session.
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, msg text) RETURNS void AS $f$
BEGIN
  IF NOT cond THEN
    RAISE EXCEPTION 'SCHEMA ASSERTION FAILED: %', msg;
  END IF;
END;
$f$ LANGUAGE plpgsql;

-- ─── Tables exist ───────────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'document_processing_batches') = 1,
    'document_processing_batches table is missing'
  );
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'document_processing_jobs') = 1,
    'document_processing_jobs table is missing'
  );
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'job_intake_locks') = 1,
    'job_intake_locks table is missing'
  );
END $$;

-- ─── Required columns exist with the expected type ─────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.assert(
    (SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'job_intake_locks' AND column_name = 'last_progress_at') = 'timestamp with time zone',
    'job_intake_locks.last_progress_at is missing or has the wrong type (migration 033)'
  );

  PERFORM pg_temp.assert(
    (SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'document_processing_jobs'
       AND column_name IN ('status', 'attempts', 'run_after', 'locked_at', 'started_at', 'completed_at', 'result', 'error_message', 'parent_job_id', 'document_id')) = 10,
    'document_processing_jobs is missing one or more required columns (migration 034)'
  );

  PERFORM pg_temp.assert(
    (SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'document_processing_batches'
       AND column_name IN ('status', 'classification_triggered', 'job_id', 'builder_id', 'primary_file_id', 'quote_id')) = 6,
    'document_processing_batches is missing one or more required columns (migration 034)'
  );

  PERFORM pg_temp.assert(
    (SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'files' AND column_name = 'processing_batch_id') = 'uuid',
    'files.processing_batch_id is missing or has the wrong type (migration 034)'
  );

  PERFORM pg_temp.assert(
    (SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'jobs'
       AND column_name IN ('knowledge_confidence', 'knowledge_missing_count', 'knowledge_updated_at')) = 3,
    'jobs is missing one or more knowledge_* columns (migration 035)'
  );
END $$;

-- ─── CHECK constraints on status columns ───────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'document_processing_jobs' AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%pending%running%completed%failed%') >= 1,
    'document_processing_jobs is missing its status CHECK constraint (pending/running/completed/failed)'
  );
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'document_processing_batches' AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%pending%running%completed%completed_with_failures%failed%') >= 1,
    'document_processing_batches is missing its status CHECK constraint'
  );
END $$;

-- ─── Foreign keys ───────────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'document_processing_jobs' AND c.contype = 'f'
       AND c.confrelid = 'document_processing_batches'::regclass) = 1,
    'document_processing_jobs.parent_job_id foreign key to document_processing_batches is missing'
  );
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'files' AND c.contype = 'f'
       AND c.confrelid = 'document_processing_batches'::regclass) = 1,
    'files.processing_batch_id foreign key to document_processing_batches is missing'
  );
END $$;

-- ─── Indexes ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_indexes WHERE tablename = 'document_processing_jobs' AND indexname = 'document_processing_jobs_status_idx') = 1,
    'document_processing_jobs_status_idx is missing'
  );
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_indexes WHERE tablename = 'document_processing_jobs' AND indexname = 'document_processing_jobs_parent_job_id_idx') = 1,
    'document_processing_jobs_parent_job_id_idx is missing'
  );
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_indexes WHERE tablename = 'document_processing_jobs' AND indexname = 'document_processing_jobs_locked_at_idx') = 1,
    'document_processing_jobs_locked_at_idx is missing'
  );
  -- The partial claim index must still be a partial index on the exact
  -- predicate claim_next_document_job's WHERE clause matches — a plain,
  -- non-partial index here would silently stop being a single index scan.
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_indexes
     WHERE tablename = 'document_processing_jobs' AND indexname = 'document_processing_jobs_claim_idx'
       AND indexdef LIKE '%WHERE%status%pending%') = 1,
    'document_processing_jobs_claim_idx is missing or is no longer a partial index on status = ''pending'''
  );
END $$;

-- ─── Functions exist with the expected argument signature ──────────────────
DO $$ BEGIN
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_proc WHERE proname = 'claim_next_document_job' AND pg_get_function_arguments(oid) = 'p_parent_job_id uuid') = 1,
    'claim_next_document_job(uuid) function is missing or its signature changed'
  );
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_proc WHERE proname = 'complete_document_job' AND pg_get_function_arguments(oid) = 'p_job_id uuid, p_result jsonb') = 1,
    'complete_document_job(uuid, jsonb) function is missing or its signature changed'
  );
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_proc WHERE proname = 'retry_or_fail_document_job') = 1,
    'retry_or_fail_document_job function is missing'
  );
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_proc WHERE proname = 'recompute_parent_batch_status' AND pg_get_function_arguments(oid) = 'p_parent_job_id uuid') = 1,
    'recompute_parent_batch_status(uuid) function is missing or its signature changed'
  );
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_proc WHERE proname = 'reclaim_stale_document_jobs') = 1,
    'reclaim_stale_document_jobs function is missing (migration 036)'
  );
END $$;

-- ─── Functions are actually callable (not just present) ────────────────────
-- Each call below is constructed to touch zero real rows, so this is safe
-- to run against production: bogus/non-existent uuids match nothing in a
-- WHERE id = ... / WHERE parent_job_id = ... clause, and an interval far in
-- the future for reclaim_stale_document_jobs matches no realistically-stale
-- row. A function that has been dropped, renamed, or had its argument
-- order/types changed underneath a caller fails here with a clear
-- "function does not exist" error instead of surfacing for the first time
-- as a runtime 404 from PostgREST.
DO $$
DECLARE
  v_bogus_uuid uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  PERFORM * FROM claim_next_document_job(v_bogus_uuid);
  PERFORM * FROM recompute_parent_batch_status(v_bogus_uuid);
  PERFORM * FROM complete_document_job(v_bogus_uuid, '{}'::jsonb);
  PERFORM * FROM retry_or_fail_document_job(v_bogus_uuid, 'schema_assertions.sql callability probe', 3);
  PERFORM * FROM reclaim_stale_document_jobs(interval '100 years', v_bogus_uuid);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'SCHEMA ASSERTION FAILED: one or more document-processing functions are not callable: %', SQLERRM;
END $$;

-- ─── RLS enabled + policies exist ───────────────────────────────────────────
DO $$ BEGIN
  PERFORM pg_temp.assert(
    (SELECT relrowsecurity FROM pg_class WHERE relname = 'document_processing_batches') = true,
    'document_processing_batches does not have RLS enabled'
  );
  PERFORM pg_temp.assert(
    (SELECT relrowsecurity FROM pg_class WHERE relname = 'document_processing_jobs') = true,
    'document_processing_jobs does not have RLS enabled'
  );
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_policies WHERE tablename = 'document_processing_batches' AND policyname = 'document_processing_batches_own_builder') = 1,
    'document_processing_batches_own_builder RLS policy is missing'
  );
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_policies WHERE tablename = 'document_processing_jobs' AND policyname = 'document_processing_jobs_own_builder') = 1,
    'document_processing_jobs_own_builder RLS policy is missing'
  );
END $$;

DO $$ BEGIN RAISE NOTICE 'schema_assertions.sql: all assertions passed.'; END $$;
