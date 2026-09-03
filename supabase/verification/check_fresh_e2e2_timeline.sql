-- READ-ONLY. Find the most recent known-good-estimate synthetic job (builder
-- 00000000-0000-0000-0000-0000000000fc) and give a full timeline for it, to
-- measure whether migration 104's ORDER BY fix actually shortens the
-- recovery-latency gap observed on the previous fresh E2E job (4f8824d2).
-- Zero writes.

\echo '=== most recent known-good synthetic job ==='
SELECT id, address, created_at
FROM jobs
WHERE builder_id = '00000000-0000-0000-0000-0000000000fc'
ORDER BY created_at DESC
LIMIT 3;

\echo '=== its most recent batch ==='
SELECT b.id, b.job_id, b.status, b.classification_triggered, b.created_at, b.updated_at,
       b.scope_reasoning_completed_at, b.stall_stage, b.stalled_at, b.stall_count, b.quote_id
FROM document_processing_batches b
WHERE b.job_id IN (
  SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fc'
  ORDER BY created_at DESC LIMIT 1
)
ORDER BY b.created_at DESC;

\echo '=== ai_operations for that job, in order ==='
SELECT call_site, status, error_classification, duration_ms, created_at, completed_at
FROM ai_operations
WHERE scope_key LIKE '%' || (
  SELECT id::text FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fc'
  ORDER BY created_at DESC LIMIT 1
) || '%'
ORDER BY created_at ASC;

\echo '=== quote ==='
SELECT id, status, total_cost, overall_confidence, qa_report IS NOT NULL AS has_qa, created_at
FROM quotes
WHERE job_id IN (
  SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fc'
  ORDER BY created_at DESC LIMIT 1
);

\echo '=== estimate_run + events ==='
SELECT er.id, er.status, er.builder_status, er.started_at, er.completed_at, er.reconciled_at
FROM estimate_runs er
WHERE er.job_id IN (
  SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fc'
  ORDER BY created_at DESC LIMIT 1
);

SELECT ere.created_at, ere.from_status, ere.to_status, ere.detail
FROM estimate_run_events ere
JOIN estimate_runs er ON er.id = ere.estimate_run_id
WHERE er.job_id IN (
  SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fc'
  ORDER BY created_at DESC LIMIT 1
)
ORDER BY ere.created_at ASC;

\echo '=== job_intake_locks (still active?) ==='
SELECT * FROM job_intake_locks
WHERE job_id IN (
  SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fc'
  ORDER BY created_at DESC LIMIT 1
);

\echo '=== recent intake_recovery_runs, last 15 ==='
SELECT run_started_at, run_finished_at, document_jobs_reclaimed, batches_resumed,
       job_locks_reclaimed, stuck_files_retried, files_permanently_failed, errors
FROM intake_recovery_runs
ORDER BY run_started_at DESC
LIMIT 15;

\echo '=== now ==='
SELECT now();
