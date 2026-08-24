-- STOP-condition diagnosis: Run 4's batch (9c124f0e-b03c-4666-9b15-4f2426a35718,
-- estimate_run f0a1bd1a-63b3-4e7a-8822-705569d94f1f) has deadline_at
-- (23:40:40) passed 2+ hours ago with deadline_extensions_used=0 and
-- builder_status still NULL, despite matching the extension-eligible
-- predicate (stage3_failure_count=0, stage6_failure_count=0, quote_id
-- NULL, no lock, no ai_failure). Neither extended nor finalized. Read-only.

\echo '=== estimate_runs row raw, fresh read ==='
SELECT id, batch_id, status, builder_status, deadline_extensions_used, deadline_at,
       now() - deadline_at AS overdue_by, started_at, completed_at
FROM estimate_runs
WHERE id = 'f0a1bd1a-63b3-4e7a-8822-705569d94f1f';

\echo '=== Does this row match enforce_estimate_deadlines'' outer WHERE clause right now? ==='
SELECT id, (deadline_at < now()) AS deadline_passed, (builder_status IS NULL) AS status_null
FROM estimate_runs WHERE id = 'f0a1bd1a-63b3-4e7a-8822-705569d94f1f';

\echo '=== Does this batch match the extension-eligibility EXISTS subquery (migration 089) right now? ==='
SELECT
  b.id,
  (b.quote_id IS NULL) AS quote_null,
  (b.status IN ('completed','completed_with_failures','failed')) AS status_ok,
  b.classification_triggered,
  (b.stage3_failure_count = 0) AS stage3_ok,
  (b.stage6_failure_count = 0) AS stage6_ok,
  NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = b.job_id) AS no_lock,
  NOT EXISTS (
    SELECT 1 FROM document_processing_jobs j
    JOIN files f ON f.id = j.document_id
    WHERE j.parent_job_id = b.id AND f.ai_failure_count > 0
  ) AS no_ai_failure
FROM document_processing_batches b
WHERE b.id = '9c124f0e-b03c-4666-9b15-4f2426a35718';

\echo '=== find_stuck_batches_needing_classification_retry: does it currently return this batch? ==='
SELECT * FROM find_stuck_batches_needing_classification_retry()
WHERE batch_id = '9c124f0e-b03c-4666-9b15-4f2426a35718';

\echo '=== Live function body of enforce_estimate_deadlines (confirm deployed version matches migration 089) ==='
SELECT pg_get_functiondef('enforce_estimate_deadlines'::regproc);

\echo '=== Any lock currently held on estimate_runs (row or relation) right now? ==='
SELECT l.locktype, l.mode, l.granted, l.pid, a.state, a.xact_start, now() - a.xact_start AS xact_age, a.query
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.relation = 'estimate_runs'::regclass;

\echo '=== Any idle-in-transaction sessions at all (could silently hold locks) ==='
SELECT pid, state, xact_start, now() - xact_start AS xact_age, query
FROM pg_stat_activity
WHERE state = 'idle in transaction' AND xact_start < now() - interval '2 minutes';

\echo '=== intake_recovery_runs: deadlines_enforced across the last 30 ticks (any nonzero at all recently?) ==='
SELECT created_at, deadlines_enforced, document_jobs_reclaimed, stuck_files_retried, errors
FROM intake_recovery_runs
ORDER BY created_at DESC
LIMIT 30;

\echo '=== pg_cron tick history, last 15 (still firing?) ==='
SELECT jrd.runid, jrd.status, jrd.start_time
FROM cron.job_run_details jrd
JOIN cron.job j ON j.jobid = jrd.jobid
WHERE j.jobname = 'worka-intake-recovery'
ORDER BY jrd.start_time DESC
LIMIT 15;

\echo '=== Financial safety: total_ai_call_attempts / ai_operations unchanged? ==='
SELECT total_ai_call_attempts, stage6_active_calls, updated_at
FROM document_processing_batches WHERE id = '9c124f0e-b03c-4666-9b15-4f2426a35718';

SELECT count(*) AS total_ops, sum(cost_cents) AS total_cost_cents, max(created_at) AS last_call_at
FROM ai_operations
WHERE scope_key LIKE '58b4eef0-78c2-4f48-ac74-c566ac81801f:%';

\echo '=== ai_circuit_breaker ==='
SELECT value FROM system_status WHERE key = 'ai_circuit_breaker';
