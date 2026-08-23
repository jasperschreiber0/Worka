-- Read-only: diagnose run 2's failure cause
-- (job 464d446b-fa86-49ba-adc1-0676ac4dbe59, batch 08d7c7d6-dbb2-44d2-9eee-36b68afe1222)

\echo '=== Batch full row ==='
SELECT id, status, stall_stage, stall_reason, stall_count, total_ai_call_attempts,
       stage3_failure_count, stage3_failure_classification, stage6_failure_count,
       classification_triggered, quote_id, scope_reasoning_completed_at,
       created_at, updated_at
FROM document_processing_batches
WHERE id = '08d7c7d6-dbb2-44d2-9eee-36b68afe1222';

\echo '=== Files for this job ==='
SELECT id, intake_status, failure_stage, failure_reason, ai_failure_count, ai_failure_classification
FROM files
WHERE job_id = '464d446b-fa86-49ba-adc1-0676ac4dbe59';

\echo '=== estimate_runs for this job ==='
SELECT id, status, builder_status, needs_review_reason, needs_review_reason_code, failure_reason
FROM estimate_runs
WHERE job_id = '464d446b-fa86-49ba-adc1-0676ac4dbe59';

\echo '=== job_intake_locks (should be empty) ==='
SELECT * FROM job_intake_locks WHERE job_id = '464d446b-fa86-49ba-adc1-0676ac4dbe59';
