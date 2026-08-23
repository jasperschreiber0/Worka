-- Read-only monitor for post-fix Run 1 (job 71d94af9, batch 5f0c76a2).
-- No writes. Safe to run repeatedly.

\echo '=== Batch state ==='
SELECT id, status, stall_stage, stall_count, total_ai_call_attempts,
       stage3_failure_count, stage6_failure_count,
       array_length(stage3_completed_trade_ids, 1) AS stage3_trades_done,
       array_length(stage6_completed_trade_ids, 1) AS stage6_trades_done,
       quote_id, updated_at, now() - updated_at AS since_update
FROM document_processing_batches
WHERE id = '5f0c76a2-e666-4476-aa7d-a82da7b4080c';

\echo '=== estimate_run for this job ==='
SELECT status, builder_status, deadline_at, deadline_extensions_used, completed_at
FROM estimate_runs
WHERE job_id = '71d94af9-d09d-4954-9601-28f1bb656558';

\echo '=== ai_operations for stage_estimate_generation on this job (per-call detail) ==='
SELECT id, created_at, completed_at, status, cost_cents, duration_ms, error_classification
FROM ai_operations
WHERE scope_key LIKE '71d94af9-d09d-4954-9601-28f1bb656558:stage_estimate_generation%'
ORDER BY created_at ASC;

\echo '=== Overlap check: were any two stage_estimate_generation calls in flight concurrently? ==='
SELECT a.id AS call_a, b.id AS call_b, a.created_at AS a_start, a.completed_at AS a_end,
       b.created_at AS b_start, b.completed_at AS b_end
FROM ai_operations a
JOIN ai_operations b ON a.id < b.id
  AND a.scope_key LIKE '71d94af9-d09d-4954-9601-28f1bb656558:stage_estimate_generation%'
  AND b.scope_key LIKE '71d94af9-d09d-4954-9601-28f1bb656558:stage_estimate_generation%'
  AND a.created_at < b.completed_at AND b.created_at < a.completed_at;

\echo '=== job_intake_locks right now ==='
SELECT job_id, file_id, started_at, last_progress_at FROM job_intake_locks;

\echo '=== ai_circuit_breaker right now ==='
SELECT key, value, updated_at FROM system_status WHERE key = 'ai_circuit_breaker';

\echo '=== Most recent intake_recovery_runs (cron cadence check) ==='
SELECT id, created_at, job_locks_reclaimed, stuck_files_retried, errors
FROM intake_recovery_runs
ORDER BY created_at DESC
LIMIT 5;
