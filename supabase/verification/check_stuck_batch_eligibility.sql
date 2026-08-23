-- Read-only diagnostic: why is batch f53db004-c8a1-471e-aaa9-34abae45ceb0
-- (job 9f08fde6, the post-slot-claim-fix reliability test run) not being
-- picked up by find_stuck_batches_needing_classification_retry(), despite
-- appearing to satisfy every condition in the WHERE clause?
-- Prints each predicate individually rather than relying on the aggregate
-- function result, so the exact excluding condition is visible.

\echo '=== Raw RPC result (should include f53db004 if truly eligible) ==='
SELECT * FROM find_stuck_batches_needing_classification_retry();

\echo '=== Batch row, all relevant columns ==='
SELECT
  id, status, classification_triggered, updated_at,
  now() - updated_at AS age,
  stage3_failure_count, stage6_failure_count
FROM document_processing_batches
WHERE id = 'f53db004-c8a1-471e-aaa9-34abae45ceb0';

\echo '=== job_intake_locks for this job (should be empty) ==='
SELECT * FROM job_intake_locks WHERE job_id = '9f08fde6-f631-4d30-b955-53c7a41166c1';

\echo '=== estimate_runs for this batch (builder_status must be NULL) ==='
SELECT id, batch_id, status, builder_status, deadline_at, now() > deadline_at AS deadline_passed
FROM estimate_runs
WHERE batch_id = 'f53db004-c8a1-471e-aaa9-34abae45ceb0';

\echo '=== document_processing_jobs with ai_failure_count > 0 for this batch (should be none) ==='
SELECT j.id, j.document_id, j.status, f.ai_failure_count
FROM document_processing_jobs j
JOIN files f ON f.id = j.document_id
WHERE j.parent_job_id = 'f53db004-c8a1-471e-aaa9-34abae45ceb0'
  AND f.ai_failure_count > 0;

\echo '=== intake_recovery_attempts on the primary file (retry cap check) ==='
SELECT id, intake_recovery_attempts, intake_status, failure_stage
FROM files
WHERE id = '80bd56c5-016d-4b4c-8c8a-0cd66cb905a0';
