-- READ-ONLY. Batch 85b7a359 (fresh E2E job 4f8824d2) stalled mid-Stage-6
-- (6/8 trades) at 08:53:36 UTC and has not been touched since (updated_at
-- frozen), despite no active lock and 10+ minutes elapsed -- well past any
-- grace period. This evaluates every clause of the live
-- find_stuck_batches_needing_classification_retry predicate directly
-- against this exact batch to find the precise blocking condition. Zero
-- writes.

\echo '=== live function definition ==='
SELECT pg_get_functiondef('find_stuck_batches_needing_classification_retry'::regproc);

\echo '=== batch row, full detail ==='
SELECT id, job_id, quote_id, status, classification_triggered, updated_at,
       stage3_failure_count, stage6_failure_count, stall_stage, stalled_at, stall_count,
       scope_reasoning_completed_at
FROM document_processing_batches
WHERE id = '85b7a359-3388-4d73-9684-05e05ca8930b';

\echo '=== per-clause evaluation ==='
SELECT
  b.status IN ('completed', 'completed_with_failures', 'failed') AS status_terminal,
  b.classification_triggered AS classification_triggered,
  b.updated_at < now() - interval '3 minutes' AS past_grace_period,
  b.stage3_failure_count = 0 AS stage3_failure_count_zero,
  b.stage6_failure_count = 0 AS stage6_failure_count_zero,
  NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = b.job_id) AS no_job_intake_lock,
  NOT EXISTS (SELECT 1 FROM estimate_runs er WHERE er.batch_id = b.id AND er.builder_status IS NOT NULL) AS no_finalized_estimate_run,
  NOT EXISTS (
    SELECT 1 FROM document_processing_jobs j
    JOIN files f ON f.id = j.document_id
    WHERE j.parent_job_id = b.id
      AND f.ai_failure_count > 0
      AND NOT EXISTS (SELECT 1 FROM project_documents pd WHERE pd.file_id = f.id AND pd.extraction_status = 'complete')
  ) AS no_unresolved_ai_failure
FROM document_processing_batches b
WHERE b.id = '85b7a359-3388-4d73-9684-05e05ca8930b';

\echo '=== live RPC result: is this batch actually returned right now? ==='
SELECT * FROM find_stuck_batches_needing_classification_retry();

\echo '=== recent intake_recovery_runs, last 10 -- was this batch mentioned/resumed? ==='
SELECT run_started_at, run_finished_at, document_jobs_reclaimed, batches_resumed,
       job_locks_reclaimed, stuck_files_retried, files_permanently_failed, errors
FROM intake_recovery_runs
WHERE run_started_at > '2026-09-03 08:53:00+00'
ORDER BY run_started_at ASC
LIMIT 15;

\echo '=== now ==='
SELECT now();
