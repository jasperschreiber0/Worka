-- Read-only: why did Stage 3 (scope reasoning) never progress at all for
-- Run 3 (job 89b77f76-7cb3-427d-ae81-919ea2320c35, batch bdeca4fa-4f36-4e95-b87a-4fb063724fde)?
-- "0 of 13 trades reasoned through" for the entire ~15-minute run, 2 total AI calls.

\echo '=== Batch full row ==='
SELECT id, job_id, status, classification_triggered, quote_id,
       stall_stage, stall_reason, stalled_at, stall_count,
       scope_reasoning_completed_at,
       array_length(stage3_completed_trade_ids,1) AS stage3_done,
       array_length(stage6_completed_trade_ids,1) AS stage6_done,
       stage3_failure_count, stage6_failure_count,
       total_ai_call_attempts, stage6_active_calls,
       created_at, updated_at
FROM document_processing_batches
WHERE id = 'bdeca4fa-4f36-4e95-b87a-4fb063724fde';

\echo '=== ai_operations for this job (every call attempted, with status/error) ==='
SELECT id, call_site, status, error_message, created_at, completed_at,
       EXTRACT(EPOCH FROM (COALESCE(completed_at, now()) - created_at)) AS duration_s
FROM ai_operations
WHERE scope_key LIKE '89b77f76-7cb3-427d-ae81-919ea2320c35:%'
ORDER BY created_at;

\echo '=== document_processing_jobs for this batch ==='
SELECT id, document_id, status, attempts, error_message, created_at, updated_at
FROM document_processing_jobs
WHERE parent_job_id = 'bdeca4fa-4f36-4e95-b87a-4fb063724fde';

\echo '=== project_documents for this job (extraction_status) ==='
SELECT id, file_id, extraction_status, document_type, created_at
FROM project_documents
WHERE job_id = '89b77f76-7cb3-427d-ae81-919ea2320c35';

\echo '=== project_facts count for this job ==='
SELECT count(*) AS fact_count FROM project_facts WHERE job_id = '89b77f76-7cb3-427d-ae81-919ea2320c35';

\echo '=== scope_items count for this job (Stage 3 output) ==='
SELECT count(*) AS scope_item_count FROM scope_items WHERE job_id = '89b77f76-7cb3-427d-ae81-919ea2320c35';

\echo '=== job_intake_locks for this job (still held? cleared?) ==='
SELECT * FROM job_intake_locks WHERE job_id = '89b77f76-7cb3-427d-ae81-919ea2320c35';

\echo '=== files.ai_failure_classification / failure_stage for this job's primary file ==='
SELECT id, intake_status, ai_failure_classification, ai_failure_count, failure_stage, intake_recovery_attempts
FROM files
WHERE id = 'b27aafa4-6ccd-41f3-a434-73fb7f08174a';

\echo '=== estimate_runs for this batch ==='
SELECT id, status, builder_status, needs_review_reason, deadline_extensions_used, deadline_at, started_at, completed_at
FROM estimate_runs
WHERE batch_id = 'bdeca4fa-4f36-4e95-b87a-4fb063724fde';

\echo '=== ai_circuit_breaker current state ==='
SELECT value FROM system_status WHERE key = 'ai_circuit_breaker';
