-- 047_atomic_job_ref_generation.sql
-- Fixes a pre-existing race condition in generate_job_ref() (migration 006),
-- unrelated to the intake-pipeline work in migrations 037-046 but
-- discovered while testing it: creating a job was failing with
-- `duplicate key value violates unique constraint "jobs_job_ref_key"`.
--
-- Root cause: generate_job_ref() computes the next sequence number as
-- `SELECT COUNT(*) + 1 FROM jobs WHERE builder_id = ... AND year = ...`
-- with no locking. Under Postgres's default READ COMMITTED isolation, two
-- near-simultaneous INSERTs for the same builder (e.g. a builder retrying
-- a failed "new job" chat message a few times in quick succession) can
-- both run that SELECT before either transaction commits — both see the
-- same count, both compute the identical job_ref, and every insert after
-- the first one to actually commit violates the UNIQUE constraint. This
-- is a genuine concurrency bug that predates this session; it just needed
-- rapid retries to surface it.
--
-- Fix: pg_advisory_xact_lock serializes concurrent inserts for the SAME
-- builder+year — a second transaction's trigger blocks at the lock call
-- until the first one commits (or rolls back), so its COUNT read always
-- sees the first insert's row and correctly computes the next number.
-- The lock is transaction-scoped (released automatically at commit/
-- rollback, no explicit unlock needed) and keyed narrowly (only builder+
-- year contends), so it can't create cross-builder contention or a
-- deadlock with any other lock this codebase takes. Ref FORMAT is
-- unchanged (JOB-YYYY-NNN) — this only fixes how the number is computed.

CREATE OR REPLACE FUNCTION generate_job_ref()
RETURNS TRIGGER AS $$
DECLARE
  seq_num int;
  yr text;
BEGIN
  yr := to_char(NOW(), 'YYYY');

  -- Serialize concurrent inserts for this exact builder+year — see the
  -- migration header for the race this closes.
  PERFORM pg_advisory_xact_lock(hashtext('job_ref:' || NEW.builder_id::text || ':' || yr)::bigint);

  SELECT COUNT(*) + 1 INTO seq_num
  FROM jobs
  WHERE builder_id = NEW.builder_id
    AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW());
  NEW.job_ref := 'JOB-' || yr || '-' || LPAD(seq_num::text, 3, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
