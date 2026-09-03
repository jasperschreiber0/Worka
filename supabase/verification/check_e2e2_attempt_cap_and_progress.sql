-- READ-ONLY. AI_RECOVERY_DISABLED=false, circuit breaker not tripped, and
-- find_stuck_batches_needing_classification_retry() correctly returns
-- batch 9f14b072 -- yet no retrigger has landed after 7+ minutes past
-- grace. Checks files.intake_recovery_attempts (the record_intake_recovery_
-- attempt cap that could silently `continue` the loop in route.ts if
-- already at MAX_RECOVERY_ATTEMPTS=3) and whether ANY batch/ai_operations
-- state has moved since the last check (09:27:13). Zero writes.

\echo '=== files.intake_recovery_attempts for the batch primary file ==='
SELECT id, intake_status, intake_recovery_attempts, ai_failure_count, failure_reason
FROM files WHERE id = 'e1316de3-cb84-4869-a8b9-d30d14eecb69';

\echo '=== batch row right now (has anything moved since 09:27:13?) ==='
SELECT id, status, updated_at, total_ai_call_attempts, stage6_completed_trade_ids, stall_stage, stalled_at
FROM document_processing_batches WHERE id = '9f14b072-5c91-4c0f-b238-adcef1a87fc8';

\echo '=== ai_operations for this job right now (any new rows since 09:19?) ==='
SELECT call_site, status, error_classification, duration_ms, created_at, completed_at
FROM ai_operations
WHERE scope_key LIKE '%dbcc6f7d-6b7c-4862-8c2c-cb96e9143bb3%'
ORDER BY created_at ASC;

\echo '=== job_intake_locks right now ==='
SELECT * FROM job_intake_locks WHERE job_id = 'dbcc6f7d-6b7c-4862-8c2c-cb96e9143bb3';

\echo '=== intake_recovery_runs, last 8 ticks ==='
SELECT run_started_at, run_finished_at, batches_resumed, job_locks_reclaimed,
       stuck_files_retried, files_permanently_failed, errors
FROM intake_recovery_runs
ORDER BY run_started_at DESC
LIMIT 8;

\echo '=== now ==='
SELECT now();
