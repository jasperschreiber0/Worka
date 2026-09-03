-- READ-ONLY. Checks whether the real E2E test's stalled batch (Stage 6
-- partially complete, 6/8 trades) has been resumed and completed by the
-- real autonomous pg_cron recovery mechanism. Zero writes, zero triggers.

\echo '=== 1. Target batch current state ==='
SELECT id, job_id, status, classification_triggered, quote_id,
       scope_reasoning_completed_at, stall_stage, stall_reason, stalled_at, stall_count,
       stage3_failure_count, stage6_failure_count
FROM document_processing_batches
WHERE id = '82696199-7590-4069-8d5d-0c64c6940fcc';

\echo '=== 2. Quote for this job, if any ==='
SELECT id, job_id, status, total_cost, overall_confidence,
       qa_report IS NOT NULL AS has_qa, created_at
FROM quotes
WHERE job_id = '1eec138a-09d7-42fa-afdc-6e653b01a333'
ORDER BY created_at DESC;

\echo '=== 3. estimate_runs for this job ==='
SELECT id, status, builder_status, deadline_extensions_used, deadline_at, started_at, completed_at
FROM estimate_runs
WHERE job_id = '1eec138a-09d7-42fa-afdc-6e653b01a333';

\echo '=== 4. Recent intake_recovery_runs, has it touched this batch? ==='
SELECT run_started_at, run_finished_at, document_jobs_reclaimed, batches_resumed,
       job_locks_reclaimed, stuck_files_retried, files_permanently_failed, errors
FROM intake_recovery_runs
ORDER BY run_started_at DESC
LIMIT 10;

\echo '=== 5. job_intake_locks for this job (should be transient/absent between resumed invocations) ==='
SELECT * FROM job_intake_locks WHERE job_id = '1eec138a-09d7-42fa-afdc-6e653b01a333';

\echo '=== 6. Quote line items count, if a quote now exists ==='
SELECT q.id AS quote_id, count(qli.id) AS line_item_count
FROM quotes q
LEFT JOIN quote_line_items qli ON qli.quote_id = q.id
WHERE q.job_id = '1eec138a-09d7-42fa-afdc-6e653b01a333'
GROUP BY q.id;
