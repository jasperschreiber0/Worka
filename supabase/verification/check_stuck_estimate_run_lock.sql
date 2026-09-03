-- READ-ONLY. estimate_run c2505dc6-6eb1-4df2-bb80-308a23ad6345 (job 1f12de7f,
-- deadline 2026-09-03 07:11:19) is 30+ minutes past its deadline with
-- builder_status still NULL and deadline_extensions_used still 0, despite
-- enforce_estimate_deadlines() running every minute with deadlines_enforced=0
-- every single tick (per Railway logs). FOR UPDATE SKIP LOCKED silently skips
-- a row held by another transaction with no error -- checking for exactly
-- that: a long-running or idle-in-transaction session holding a lock on this
-- row, which would explain total silent non-processing. Zero writes.

\echo '=== 1. The row itself, one more time for certainty ==='
SELECT id, job_id, batch_id, status, builder_status, deadline_at, deadline_extensions_used,
       started_at, completed_at, reconciled_at, now() - deadline_at AS overdue_by
FROM estimate_runs
WHERE id = 'c2505dc6-6eb1-4df2-bb80-308a23ad6345';

\echo '=== 2. Any lock currently held on this specific row (via ctid) ==='
SELECT l.locktype, l.mode, l.granted, l.pid,
       a.state, a.query, a.xact_start, a.query_start, now() - a.xact_start AS xact_age
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.relation = 'estimate_runs'::regclass;

\echo '=== 3. Any long-running or idle-in-transaction session at all right now ==='
SELECT pid, state, now() - xact_start AS xact_age, now() - query_start AS query_age,
       left(query, 200) AS query
FROM pg_stat_activity
WHERE state != 'idle'
  AND pid != pg_backend_pid()
ORDER BY xact_start ASC NULLS LAST;

\echo '=== 4. Does this row actually match the enforce_estimate_deadlines WHERE clause right now? ==='
SELECT id, deadline_at < now() AS deadline_passed, builder_status IS NULL AS builder_status_null
FROM estimate_runs
WHERE id = 'c2505dc6-6eb1-4df2-bb80-308a23ad6345';

\echo '=== 5. How many rows total currently match that WHERE clause (contention/backlog check) ==='
SELECT count(*) FROM estimate_runs WHERE deadline_at < now() AND builder_status IS NULL;

\echo '=== 6. The batch this run points to -- does the extension-eligibility EXISTS clause even find it? ==='
SELECT b.id, b.status, b.classification_triggered, b.quote_id, b.stage3_failure_count, b.stage6_failure_count,
       b.scope_reasoning_completed_at
FROM document_processing_batches b
WHERE b.id = '71812eae-5e7c-4e2b-81ef-9f6880385cb6';
