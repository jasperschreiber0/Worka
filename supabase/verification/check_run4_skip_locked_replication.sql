-- Decisive, non-mutating check: replicate enforce_estimate_deadlines'
-- EXACT row-selection query (same WHERE clause, same FOR UPDATE SKIP
-- LOCKED) as its own standalone statement. A bare SELECT ... FOR UPDATE
-- takes no writes -- it only acquires/releases row locks within this
-- statement's own implicit transaction, then autocommits with nothing
-- changed. This proves/disproves whether SKIP LOCKED itself is what's
-- excluding Run 4's row right now, without finalizing or extending
-- anything.

\echo '=== Total rows currently matching the outer WHERE clause (no SKIP LOCKED) ==='
SELECT count(*) AS total_matching_rows
FROM estimate_runs
WHERE deadline_at < now() AND builder_status IS NULL;

\echo '=== All such rows, oldest first (iteration order the FOR loop would likely see) ==='
SELECT id, batch_id, job_id, status, deadline_at, deadline_extensions_used,
       now() - deadline_at AS overdue_by
FROM estimate_runs
WHERE deadline_at < now() AND builder_status IS NULL
ORDER BY deadline_at
LIMIT 50;

\echo '=== EXACT replication: SELECT ... FOR UPDATE SKIP LOCKED (same predicate, no writes) -- does Run 4''s row survive? ==='
SELECT id, batch_id, deadline_at
FROM estimate_runs
WHERE deadline_at < now() AND builder_status IS NULL
FOR UPDATE SKIP LOCKED;

\echo '=== Is Run 4''s specific row (f0a1bd1a) present in that FOR UPDATE SKIP LOCKED result? ==='
SELECT EXISTS (
  SELECT 1 FROM estimate_runs
  WHERE deadline_at < now() AND builder_status IS NULL
    AND id = 'f0a1bd1a-63b3-4e7a-8822-705569d94f1f'
  FOR UPDATE SKIP LOCKED
) AS run4_row_selectable_right_now;
