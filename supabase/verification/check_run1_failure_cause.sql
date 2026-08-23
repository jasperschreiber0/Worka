-- Read-only: diagnose the exact cause of run 1's failure
-- (job d943ee4b-86f5-4974-9d22-a14b5642b2d6, batch b4e7a1a6-f338-4bea-b914-36db3db7b212)

\echo '=== Batch full row ==='
SELECT id, status, stall_stage, stall_reason, stall_count, total_ai_call_attempts,
       stage3_failure_count, stage3_failure_classification, stage6_failure_count,
       classification_triggered, quote_id, scope_reasoning_completed_at,
       created_at, updated_at
FROM document_processing_batches
WHERE id = 'b4e7a1a6-f338-4bea-b914-36db3db7b212';

\echo '=== Files for this job ==='
SELECT id, intake_status, failure_stage, failure_reason, ai_failure_count, ai_failure_classification
FROM files
WHERE job_id = 'd943ee4b-86f5-4974-9d22-a14b5642b2d6';

\echo '=== document_processing_jobs for this batch ==='
SELECT id, document_id, status, attempts, error_message
FROM document_processing_jobs
WHERE parent_job_id = 'b4e7a1a6-f338-4bea-b914-36db3db7b212';

\echo '=== ai_operations for this job (real call-level evidence) ==='
SELECT id, created_at, completed_at, call_site, status, model, cost_cents, error_classification, error_message
FROM ai_operations
WHERE job_id = 'd943ee4b-86f5-4974-9d22-a14b5642b2d6'
ORDER BY created_at ASC;

\echo '=== estimate_runs for this job ==='
SELECT id, status, builder_status, needs_review_reason, needs_review_reason_code, failure_reason, stall_reason
FROM estimate_runs
WHERE job_id = 'd943ee4b-86f5-4974-9d22-a14b5642b2d6';

\echo '=== job_intake_locks (should be empty -- released cleanly, or still stuck) ==='
SELECT * FROM job_intake_locks WHERE job_id = 'd943ee4b-86f5-4974-9d22-a14b5642b2d6';

\echo '=== system_status.ai_circuit_breaker (was billing the cause?) ==='
SELECT key, value FROM system_status WHERE key = 'ai_circuit_breaker';
