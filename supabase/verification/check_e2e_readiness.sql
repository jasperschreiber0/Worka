-- READ-ONLY. Checks current state after migration 103 has had time to run
-- autonomously via pg_cron, to decide the best path for a controlled E2E
-- production verification. Zero writes.

\echo '=== 1. Did the two known drift rows get finalized/extended by the real autonomous mechanism since migration 103 deployed? ==='
SELECT id AS estimate_run_id, batch_id, job_id, status, builder_status,
       deadline_extensions_used, deadline_at, started_at, completed_at
FROM estimate_runs
WHERE id IN ('8160d6fc-0cc0-4481-8848-748849388664', 'bfb13e91-65f4-4dc7-80ea-cccba6e6cc1e');

\echo '=== 2. Latest estimate_run_events for those two runs (any new activity post-deploy?) ==='
SELECT ere.created_at, ere.from_status, ere.to_status, ere.detail
FROM estimate_run_events ere
WHERE ere.estimate_run_id IN ('8160d6fc-0cc0-4481-8848-748849388664', 'bfb13e91-65f4-4dc7-80ea-cccba6e6cc1e')
ORDER BY ere.created_at DESC
LIMIT 20;

\echo '=== 3. Target job current quote / snapshot state ==='
SELECT id, job_ref, address, stage, knowledge_confidence, knowledge_missing_count, knowledge_updated_at
FROM jobs WHERE id = '1f12de7f-47b5-442e-9581-1f813796eb70';

SELECT id, job_id, status, total_cost, overall_confidence, qa_report IS NOT NULL AS has_qa, created_at
FROM quotes WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70'
ORDER BY created_at DESC;

\echo '=== 4. Any other job currently mid-pipeline right now (a natural candidate for observing a live E2E run) ==='
SELECT er.id AS estimate_run_id, er.job_id, er.batch_id, er.status, er.builder_status,
       er.deadline_extensions_used, er.deadline_at, er.started_at
FROM estimate_runs er
WHERE er.builder_status IS NULL
ORDER BY er.started_at DESC
LIMIT 20;

\echo '=== 5. Recent intake_recovery_runs (last 15) -- confirms cron is alive and what it has been doing post-deploy ==='
SELECT run_started_at, run_finished_at, document_jobs_reclaimed, batches_resumed,
       job_locks_reclaimed, stuck_files_retried, files_permanently_failed, errors
FROM intake_recovery_runs
ORDER BY run_started_at DESC
LIMIT 15;

\echo '=== 6. System status / circuit breaker (must be closed for any real Claude calls to succeed) ==='
SELECT key, value FROM system_status WHERE key IN ('ai_circuit_breaker', 'ai_limits');

\echo '=== 7. Any job created very recently that might already be a real customer upload in flight ==='
SELECT id, job_ref, address, stage, created_at
FROM jobs
ORDER BY created_at DESC
LIMIT 10;
