-- 049_robust_job_ref_generation.sql
-- Third and hopefully final fix in this sequence (047 fixed a genuine
-- concurrency race; 048 fixed the constraint's wrong scope) — this one
-- closes a different failure mode: the collision recurred even after 048,
-- on a single non-concurrent attempt, under the correctly-scoped
-- (builder_id, job_ref) constraint. That means COUNT(*)-based numbering
-- was landing on an already-taken value for this specific builder — most
-- likely because COUNT(*) WHERE ... AND EXTRACT(YEAR FROM created_at) = ...
-- can silently exclude a row whose created_at doesn't line up with its
-- own job_ref's embedded year (backfilled data, clock skew, a manually
-- inserted row, etc.), undercounting and recomputing the same "next"
-- number every time regardless of retries.
--
-- Fix: derive the next number from the ACTUAL job_ref strings already in
-- use by this builder this year (source of truth), not a separate
-- created_at-filtered row count. Wrapped in a small bounded retry loop as
-- a defensive backstop — with the advisory lock (kept from migration 047)
-- serializing concurrent inserts for the same builder+year, this should
-- always succeed on the first pass; the loop exists so any remaining data
-- anomaly this diagnosis hasn't surfaced still can't wedge job creation.

CREATE OR REPLACE FUNCTION generate_job_ref()
RETURNS TRIGGER AS $$
DECLARE
  seq_num int;
  yr text;
  prefix text;
  attempt int := 0;
BEGIN
  yr := to_char(NOW(), 'YYYY');
  prefix := 'JOB-' || yr || '-';

  -- Serialize concurrent inserts for this builder+year (migration 047).
  PERFORM pg_advisory_xact_lock(hashtext('job_ref:' || NEW.builder_id::text || ':' || yr)::bigint);

  LOOP
    -- Source of truth: the highest number already embedded in this
    -- builder's own job_ref strings this year — immune to any created_at
    -- inconsistency, unlike a COUNT(*) filtered by a separate column.
    SELECT COALESCE(MAX(NULLIF(regexp_replace(job_ref, '^' || prefix, ''), '')::int), 0) + 1 + attempt
    INTO seq_num
    FROM jobs
    WHERE builder_id = NEW.builder_id
      AND job_ref LIKE prefix || '%';

    NEW.job_ref := prefix || LPAD(seq_num::text, 3, '0');

    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM jobs WHERE builder_id = NEW.builder_id AND job_ref = NEW.job_ref
    );

    -- Only reached if the derived number is somehow still taken (a data
    -- anomaly the MAX-based read above didn't anticipate) — bounded so a
    -- persistently broken state fails loudly instead of looping forever.
    attempt := attempt + 1;
    EXIT WHEN attempt > 20;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
