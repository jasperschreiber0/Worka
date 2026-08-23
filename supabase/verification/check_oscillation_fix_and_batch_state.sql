-- Read-only: confirm migration 091 actually excludes our test file from
-- find_and_fail_abandoned_files' candidate set now, and check the current
-- state of the batch/estimate_run/quote after several minutes of
-- (hopefully now unopposed) recovery_classification_retriggered ticks.

\echo '=== Does find_and_fail_abandoned_files still return our file as a candidate? (should be 0 rows now) ==='
SELECT * FROM find_and_fail_abandoned_files() WHERE file_id = '1a8bd032-f710-4a4c-8956-667bc978969f';

\echo '=== Current files row ==='
SELECT id, intake_status, intake_recovery_attempts, failure_stage, failure_reason
FROM files WHERE id = '1a8bd032-f710-4a4c-8956-667bc978969f';

\echo '=== Current batch checkpoint state ==='
SELECT id, status, classification_triggered, quote_id, stall_stage, stall_reason, stall_count,
       stage3_completed_trade_ids, stage6_completed_trade_ids, updated_at, now() - updated_at AS age
FROM document_processing_batches WHERE id = 'd58c3e92-d16f-425d-ad78-fbc5e8d0c86e';

\echo '=== estimate_runs ==='
SELECT id, status, builder_status, needs_review_reason, deadline_at, deadline_extensions_used, completed_at
FROM estimate_runs WHERE batch_id = 'd58c3e92-d16f-425d-ad78-fbc5e8d0c86e';

\echo '=== Quote (if any exists now) ==='
SELECT id, status, total_cost, (qa_report IS NOT NULL) AS has_qa_report
FROM quotes WHERE job_id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330';

\echo '=== job_intake_locks ==='
SELECT * FROM job_intake_locks WHERE job_id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330';

\echo '=== Last 10 intake_recovery_runs ==='
SELECT id, created_at, document_jobs_reclaimed, job_locks_reclaimed, stuck_files_retried,
       abandoned_files_marked_failed, files_permanently_failed, errors
FROM intake_recovery_runs
ORDER BY created_at DESC
LIMIT 10;
