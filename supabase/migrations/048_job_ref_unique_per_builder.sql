-- 048_job_ref_unique_per_builder.sql
-- Fixes the actual root cause of the "duplicate key value violates unique
-- constraint jobs_job_ref_key" failures that migration 047's advisory
-- lock did not resolve, because it wasn't the problem: this collision is
-- deterministic, not a timing race.
--
-- generate_job_ref() (migration 006) computes the sequence number scoped
-- to ONE builder ("SELECT COUNT(*) ... WHERE builder_id = NEW.builder_id
-- ... ") — the ref is designed to mean "this builder's Nth job this
-- year", like a per-tenant invoice number. But the UNIQUE constraint on
-- jobs.job_ref (migration 006: `ADD COLUMN job_ref text UNIQUE`) is
-- GLOBAL, across every builder in the database. Any two different
-- builders' first job of a calendar year both correctly compute
-- 'JOB-2026-001' — and the global constraint rejects the second one
-- every single time, regardless of how carefully concurrent inserts for
-- the SAME builder are serialized (which is what migration 047 fixes —
-- a real, separate bug, still worth keeping).
--
-- The constraint was simply scoped wrong from the start relative to what
-- the trigger was always designed to produce. Fix: relax it to
-- UNIQUE(builder_id, job_ref) — two different builders are allowed to
-- both have a "JOB-2026-001", exactly like two different companies each
-- having their own "Invoice #1". No change to the ref format, no change
-- to what any existing job_ref value looks like.

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_job_ref_key;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_builder_id_job_ref_key UNIQUE (builder_id, job_ref);

COMMENT ON CONSTRAINT jobs_builder_id_job_ref_key ON jobs IS
  'job_ref only needs to be unique per builder (it is a per-tenant reference number, like an invoice number) — a global unique constraint here caused every second builder''s first job of a calendar year to collide deterministically. See migration 048.';
