-- READ-ONLY. The builder just retried processing on job 1f12de7f-47b5-442e-
-- 9581-1f813796eb70 ("1234 smith street") via the real UI and got
-- "Processing failed — Processing timed out — please try again" with no
-- file breakdown. Checks what actually happened server-side: any new
-- job_intake_locks, document_processing_batches/jobs, files state changes,
-- or estimate_runs created since the last check (~06:47 UTC), to find the
-- real, current failure -- not a synthetic re-derivation. Zero writes.

\echo '=== 1. job_intake_locks right now (a lock still held = actively stuck) ==='
SELECT * FROM job_intake_locks WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70';

\echo '=== 2. Most recent document_processing_batches for this job (last 5) ==='
SELECT id, status, classification_triggered, quote_id, created_at, updated_at,
       stall_stage, stall_reason, stalled_at, stall_count,
       stage3_failure_count, stage6_failure_count
FROM document_processing_batches
WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70'
ORDER BY created_at DESC
LIMIT 5;

\echo '=== 3. Most recent document_processing_jobs across those batches (last 15) ==='
SELECT j.id, j.document_id, f.original_filename, j.status, j.attempts, j.locked_at, j.updated_at, j.result
FROM document_processing_jobs j
JOIN document_processing_batches b ON b.id = j.parent_job_id
JOIN files f ON f.id = j.document_id
WHERE b.job_id = '1f12de7f-47b5-442e-9581-1f813796eb70'
ORDER BY j.updated_at DESC
LIMIT 15;

\echo '=== 4. Files for this job -- current intake_status / ai_failure state (last updated first) ==='
SELECT id, original_filename, intake_status, intake_stage, intake_pct,
       ai_failure_classification, ai_failure_count, intake_recovery_attempts,
       failure_reason, updated_at
FROM files
WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70'
ORDER BY updated_at DESC NULLS LAST
LIMIT 15;

\echo '=== 5. Most recent estimate_runs for this job (last 5) ==='
SELECT id, status, builder_status, needs_review_reason, deadline_at,
       deadline_extensions_used, started_at, completed_at, reconciled_at
FROM estimate_runs
WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70'
ORDER BY started_at DESC
LIMIT 5;

\echo '=== 6. Recent ai_operations for this job (last 10, any call at all) ==='
SELECT call_site, status, error_classification, created_at
FROM ai_operations
WHERE scope_key LIKE '%1f12de7f-47b5-442e-9581-1f813796eb70%'
ORDER BY created_at DESC
LIMIT 10;

\echo '=== 7. Circuit breaker / spend state right now ==='
SELECT key, value FROM system_status WHERE key IN ('ai_circuit_breaker', 'ai_limits');
SELECT builder_id, day, cost_cents, call_count FROM ai_spend_daily
WHERE builder_id = '35b2582d-9a78-4083-9c88-c56010f9fc17' AND day = CURRENT_DATE;

\echo '=== 8. Current server time, for reference against all the above timestamps ==='
SELECT now();
