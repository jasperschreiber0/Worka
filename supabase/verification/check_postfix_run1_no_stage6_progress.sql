-- Read-only: why did batch 5f0c76a2 (job 71d94af9) make ZERO Stage 6
-- progress across ~15 minutes and 3 recovery-cron checks, despite Stage 3
-- completing fully and stage3/stage6_failure_count both being 0?

\echo '=== This batch full row ==='
SELECT id, status, stall_stage, stall_reason, stall_count, total_ai_call_attempts,
       stage3_failure_count, stage6_failure_count, classification_triggered,
       quote_id, scope_reasoning_completed_at, created_at, updated_at
FROM document_processing_batches
WHERE id = '5f0c76a2-e666-4476-aa7d-a82da7b4080c';

\echo '=== This job estimate_runs row (builder_status finalized? deadline?) ==='
SELECT id, status, builder_status, needs_review_reason, needs_review_reason_code,
       deadline_at, deadline_extensions_used, started_at, completed_at
FROM estimate_runs
WHERE job_id = '71d94af9-d09d-4954-9601-28f1bb656558';

\echo '=== Is this batch currently eligible per find_stuck_batches_needing_classification_retry? ==='
SELECT * FROM find_stuck_batches_needing_classification_retry()
WHERE batch_id = '5f0c76a2-e666-4476-aa7d-a82da7b4080c';

\echo '=== Recent estimate_run_events (status transitions in the last hour) ==='
SELECT ere.estimate_run_id, er.job_id, er.batch_id, ere.from_status, ere.to_status, ere.detail, ere.created_at
FROM estimate_run_events ere
JOIN estimate_runs er ON er.id = ere.estimate_run_id
WHERE ere.created_at > now() - interval '1 hour'
ORDER BY ere.created_at DESC
LIMIT 20;

\echo '=== job_intake_locks right now ==='
SELECT job_id, file_id, started_at, last_progress_at FROM job_intake_locks;

\echo '=== ai_circuit_breaker right now ==='
SELECT key, value, updated_at FROM system_status WHERE key = 'ai_circuit_breaker';

\echo '=== Any OTHER non-terminal batches from earlier test runs still around (possible interference) ==='
SELECT b.id, b.job_id, b.status, b.total_ai_call_attempts, b.updated_at,
       er.builder_status
FROM document_processing_batches b
LEFT JOIN estimate_runs er ON er.batch_id = b.id
WHERE b.status IN ('completed', 'completed_with_failures')
  AND b.classification_triggered = true
  AND b.updated_at > now() - interval '3 hours'
ORDER BY b.updated_at DESC
LIMIT 20;
