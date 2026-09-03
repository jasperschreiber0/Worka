-- READ-ONLY, passive observation only. Records: (1) has the job completed,
-- (2) elapsed time, (3) any manual intervention needed (none will be taken),
-- (4) final quote/QA state, (5) any permanently-stuck document. Zero writes.

\echo '=== estimate_run ==='
SELECT id, batch_id, status, builder_status, deadline_at, deadline_extensions_used,
       started_at, completed_at, now() - started_at AS elapsed_since_retry_start
FROM estimate_runs
WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70'
ORDER BY started_at DESC
LIMIT 1;

\echo '=== batch ==='
SELECT id, status, classification_triggered, quote_id, stall_stage, stalled_at, stall_count,
       scope_reasoning_completed_at
FROM document_processing_batches
WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70'
ORDER BY created_at DESC
LIMIT 1;

\echo '=== quote (if any) ==='
SELECT id, status, total_cost, qa_report IS NOT NULL AS has_qa, created_at
FROM quotes
WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70'
ORDER BY created_at DESC
LIMIT 1;

\echo '=== document classification progress ==='
SELECT count(*) AS documents_complete
FROM project_documents
WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70' AND extraction_status = 'complete';

\echo '=== permanently-failed files (ai_failure_count at cap) ==='
SELECT id, ai_failure_count, ai_failure_classification, intake_status
FROM files
WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70' AND ai_failure_count >= 2;

\echo '=== job_intake_locks (active = still in flight) ==='
SELECT job_id, started_at, last_progress_at FROM job_intake_locks
WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70';

\echo '=== now ==='
SELECT now();
