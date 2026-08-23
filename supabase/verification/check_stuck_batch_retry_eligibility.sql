-- Read-only: does the live recovery-eligibility RPC actually select the
-- stalled batch from the most recent multi-trade test job, and if it does,
-- why hasn't stall_count/stalled_at moved in 3+ hours of per-minute cron
-- ticks? Every predicate find_stuck_batches_needing_classification_retry
-- (migration 088) uses, checked individually against the real row.

\echo '=== stuck_files_retried + errors from recent recovery runs (column omitted from the previous diagnostic) ==='
SELECT id, created_at, stuck_files_retried, job_locks_reclaimed, errors
FROM intake_recovery_runs
WHERE created_at > now() - interval '30 minutes'
ORDER BY created_at DESC
LIMIT 20;

\echo '=== Does find_stuck_batches_needing_classification_retry() actually return our batch? ==='
SELECT * FROM find_stuck_batches_needing_classification_retry();

\echo '=== The batch row itself, all predicate-relevant columns ==='
SELECT id, status, classification_triggered, updated_at, now() - updated_at AS age,
       stage3_failure_count, stage6_failure_count, primary_file_id, builder_id
FROM document_processing_batches
WHERE id = 'd58c3e92-d16f-425d-ad78-fbc5e8d0c86e';

\echo '=== job_intake_locks for this job (must be NOT EXISTS for the RPC to match) ==='
SELECT * FROM job_intake_locks WHERE job_id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330';

\echo '=== estimate_runs.builder_status for this batch (must be NULL for the RPC to match) ==='
SELECT id, batch_id, builder_status, deadline_at, deadline_extensions_used
FROM estimate_runs WHERE batch_id = 'd58c3e92-d16f-425d-ad78-fbc5e8d0c86e';

\echo '=== document_processing_jobs + files.ai_failure_count for this batch (must all be 0 for the RPC to match) ==='
SELECT j.id AS job_row_id, j.document_id, j.status, f.ai_failure_count, f.ai_failure_classification, f.intake_recovery_attempts
FROM document_processing_jobs j
JOIN files f ON f.id = j.document_id
WHERE j.parent_job_id = 'd58c3e92-d16f-425d-ad78-fbc5e8d0c86e';

\echo '=== primary file row (the one acquire_or_reclaim_job_intake_lock / record_intake_recovery_attempt key on) ==='
SELECT id, intake_status, intake_recovery_attempts, ai_failure_count, ai_failure_classification, failure_stage, failure_reason
FROM files WHERE job_id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330';

\echo '=== system_status.ai_circuit_breaker right now ==='
SELECT key, value FROM system_status WHERE key = 'ai_circuit_breaker';
