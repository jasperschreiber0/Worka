-- Read-only: urgent check of current real-time Anthropic call activity.

\echo '=== ai_circuit_breaker current state ==='
SELECT key, value, updated_at FROM system_status WHERE key = 'ai_circuit_breaker';

\echo '=== ai_spend_daily today (global + per builder) ==='
SELECT * FROM ai_spend_daily WHERE day = CURRENT_DATE ORDER BY cost_cents DESC LIMIT 20;

\echo '=== ai_operations in the last 10 minutes (rate + status) ==='
SELECT call_site, status, count(*) AS calls, sum(cost_cents) AS total_cost_cents,
       min(created_at) AS first, max(created_at) AS last
FROM ai_operations
WHERE created_at > now() - interval '10 minutes'
GROUP BY call_site, status
ORDER BY calls DESC;

\echo '=== ai_operations in the last 2 minutes (most recent activity, raw rows) ==='
SELECT id, created_at, call_site, status, scope_key, cost_cents, error_classification, error_message
FROM ai_operations
WHERE created_at > now() - interval '2 minutes'
ORDER BY created_at DESC
LIMIT 30;

\echo '=== document_processing_batches currently running/being retriggered ==='
SELECT id, job_id, status, total_ai_call_attempts, classification_triggered, updated_at, now() - updated_at AS since_update
FROM document_processing_batches
WHERE updated_at > now() - interval '15 minutes'
ORDER BY updated_at DESC
LIMIT 20;

\echo '=== job_intake_locks currently held ==='
SELECT job_id, file_id, started_at, last_progress_at, now() - last_progress_at AS since_progress
FROM job_intake_locks
ORDER BY started_at DESC;

\echo '=== intake_recovery_runs in the last 10 minutes ==='
SELECT id, created_at, document_jobs_reclaimed, job_locks_reclaimed, stuck_files_retried, errors
FROM intake_recovery_runs
WHERE created_at > now() - interval '10 minutes'
ORDER BY created_at DESC;
