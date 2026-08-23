-- Read-only: diagnose post-fix reliability test Run 1's failure
-- (job 2e03780f-eed1-45e0-b6e8-f8aa30c20892, batch da980bfa-afca-43b1-8fba-acc95d56d482)

\echo '=== Batch full row ==='
SELECT id, status, stall_stage, stall_reason, stall_count, total_ai_call_attempts,
       stage3_failure_count, stage3_failure_classification, stage6_failure_count, stage6_failure_classification,
       classification_triggered, quote_id, scope_reasoning_completed_at,
       created_at, updated_at
FROM document_processing_batches
WHERE id = 'da980bfa-afca-43b1-8fba-acc95d56d482';

\echo '=== Files for this job ==='
SELECT id, intake_status, failure_stage, failure_reason, ai_failure_count, ai_failure_classification
FROM files
WHERE job_id = '2e03780f-eed1-45e0-b6e8-f8aa30c20892';

\echo '=== estimate_runs for this job ==='
SELECT id, status, builder_status, needs_review_reason, needs_review_reason_code, failure_reason, stall_reason
FROM estimate_runs
WHERE job_id = '2e03780f-eed1-45e0-b6e8-f8aa30c20892';

\echo '=== job_intake_locks (should be empty -- released cleanly, or still stuck) ==='
SELECT * FROM job_intake_locks WHERE job_id = '2e03780f-eed1-45e0-b6e8-f8aa30c20892';

\echo '=== system_status.ai_circuit_breaker (was billing the cause?) ==='
SELECT key, value FROM system_status WHERE key = 'ai_circuit_breaker';
