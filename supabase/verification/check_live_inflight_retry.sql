-- READ-ONLY. A new job_intake_lock for job 1f12de7f appeared, started
-- 2026-09-03 07:46:03 UTC -- a live, real-time retry in progress right now
-- (very likely the customer's own click). Checks its current state: is it
-- still progressing, stalled, or finished. Zero writes.

\echo '=== 1. job_intake_locks right now ==='
SELECT job_id, file_id, started_at, last_progress_at, now() - last_progress_at AS since_last_progress
FROM job_intake_locks WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70';

\echo '=== 2. Newest document_processing_batches for this job (last 2) ==='
SELECT id, status, classification_triggered, quote_id, created_at, updated_at,
       stall_stage, stalled_at, stall_count
FROM document_processing_batches
WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70'
ORDER BY created_at DESC
LIMIT 2;

\echo '=== 3. document_processing_jobs for the newest batch ==='
SELECT j.id, j.document_id, j.status, j.attempts, j.locked_at, j.updated_at
FROM document_processing_jobs j
WHERE j.parent_job_id = (
  SELECT id FROM document_processing_batches
  WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70'
  ORDER BY created_at DESC LIMIT 1
)
ORDER BY j.updated_at DESC;

\echo '=== 4. Most recent ai_operations for this job (last 5) ==='
SELECT call_site, status, error_classification, created_at,
       now() - created_at AS age
FROM ai_operations
WHERE scope_key LIKE '%1f12de7f-47b5-442e-9581-1f813796eb70%'
ORDER BY created_at DESC
LIMIT 5;

\echo '=== 5. All estimate_runs for this job now (including the previously-stuck c2505dc6) ==='
SELECT id, batch_id, status, builder_status, deadline_at, deadline_extensions_used,
       started_at, completed_at
FROM estimate_runs
WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70'
ORDER BY started_at DESC
LIMIT 3;

\echo '=== 6. Current time ==='
SELECT now();
