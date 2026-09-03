-- ONE-TIME, READ-ONLY investigation (no mutations). Confirms the live
-- deployed definitions of enforce_estimate_deadlines/compute_builder_status,
-- reconstructs the target run's exact event timeline, checks pg_cron wiring,
-- and assesses blast radius across all NEEDS_REVIEW runs with the same
-- signature (ai_failure_count>0 + extraction_status=complete at deadline
-- time). Zero writes.

\echo '=== 1. Deployed function definitions ==='
SELECT pg_get_functiondef('enforce_estimate_deadlines'::regproc);
SELECT pg_get_functiondef('compute_builder_status'::regproc);
SELECT pg_get_functiondef('reconcile_estimate_run'::regproc);

\echo '=== 2. pg_cron job configuration ==='
SELECT jobid, schedule, command, active FROM cron.job WHERE jobname = 'worka-intake-recovery';

\echo '=== 3. pg_cron recent run history for this job (last 20) ==='
SELECT runid, status, return_message, start_time, end_time
FROM cron.job_run_details jrd
JOIN cron.job j ON j.jobid = jrd.jobid
WHERE j.jobname = 'worka-intake-recovery'
ORDER BY start_time DESC
LIMIT 20;

\echo '=== 4. Target estimate_run full row ==='
SELECT * FROM estimate_runs WHERE batch_id = 'ac0380e4-b74b-46f0-ab9e-e42de35e71c8';

\echo '=== 5. Target estimate_run_events, full timeline ==='
SELECT ere.created_at, ere.from_status, ere.to_status, ere.detail
FROM estimate_run_events ere
JOIN estimate_runs er ON er.id = ere.estimate_run_id
WHERE er.batch_id = 'ac0380e4-b74b-46f0-ab9e-e42de35e71c8'
ORDER BY ere.created_at ASC;

\echo '=== 6. intake_recovery_runs around the deadline window (04:55-05:15 UTC) ==='
SELECT run_started_at, run_finished_at, document_jobs_reclaimed, batches_resumed,
       job_locks_reclaimed, stuck_files_retried, files_permanently_failed, errors
FROM intake_recovery_runs
WHERE run_started_at BETWEEN '2026-09-03 04:55:00+00' AND '2026-09-03 05:15:00+00'
ORDER BY run_started_at ASC;

\echo '=== 7. Blast radius: all NEEDS_REVIEW runs in the last 30 days ==='
SELECT id, batch_id, job_id, status, builder_status, needs_review_reason_code,
       deadline_extensions_used, started_at, completed_at
FROM estimate_runs
WHERE builder_status = 'NEEDS_REVIEW'
  AND started_at > now() - interval '30 days'
ORDER BY started_at DESC
LIMIT 50;

\echo '=== 8. Blast radius: NEEDS_REVIEW runs where quote_id IS NULL but a document with ai_failure_count>0 also has a completed extraction_status=complete row (the exact drift signature) ==='
SELECT er.id AS estimate_run_id, er.batch_id, er.job_id, er.builder_status,
       er.needs_review_reason_code, er.deadline_extensions_used, er.started_at, er.completed_at,
       b.stage3_failure_count, b.stage6_failure_count, b.quote_id
FROM estimate_runs er
JOIN document_processing_batches b ON b.id = er.batch_id
WHERE er.builder_status = 'NEEDS_REVIEW'
  AND b.quote_id IS NULL
  AND EXISTS (
    SELECT 1 FROM document_processing_jobs j
    JOIN files f ON f.id = j.document_id
    JOIN project_documents pd ON pd.file_id = f.id AND pd.extraction_status = 'complete'
    WHERE j.parent_job_id = b.id AND f.ai_failure_count > 0
  )
ORDER BY er.started_at DESC
LIMIT 50;

\echo '=== 9. Blast radius: genuinely-unresolved-failure NEEDS_REVIEW runs (control group -- these SHOULD remain NEEDS_REVIEW under any fix) ==='
SELECT er.id AS estimate_run_id, er.batch_id, er.job_id, er.builder_status, er.started_at
FROM estimate_runs er
JOIN document_processing_batches b ON b.id = er.batch_id
WHERE er.builder_status = 'NEEDS_REVIEW'
  AND b.quote_id IS NULL
  AND EXISTS (
    SELECT 1 FROM document_processing_jobs j
    JOIN files f ON f.id = j.document_id
    WHERE j.parent_job_id = b.id AND f.ai_failure_count > 0
      AND NOT EXISTS (SELECT 1 FROM project_documents pd WHERE pd.file_id = f.id AND pd.extraction_status = 'complete')
  )
ORDER BY er.started_at DESC
LIMIT 50;

\echo '=== 10. builder_status distribution overall (sanity) ==='
SELECT builder_status, count(*) FROM estimate_runs GROUP BY builder_status ORDER BY 2 DESC;
