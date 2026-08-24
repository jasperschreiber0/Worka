-- Final snapshot for the Run 5 performance/throughput investigation.
-- Read-only. Captures exact current state to close out the timeline.

\echo '=== Current time ==='
SELECT now();

\echo '=== Batch final/current state ==='
SELECT id, status, stall_stage, stall_reason, stall_count, stalled_at,
       total_ai_call_attempts, classification_triggered, quote_id,
       scope_reasoning_completed_at, stage6_active_calls,
       stage3_completed_trade_ids, stage6_completed_trade_ids, updated_at
FROM document_processing_batches
WHERE id = 'ff6c0f7f-5cd9-410c-b585-343293b41c3e';

\echo '=== job_intake_locks now ==='
SELECT * FROM job_intake_locks WHERE job_id = 'c1fe6f7a-6fff-450d-873f-630b07ed44c2';

\echo '=== estimate_runs full current state ==='
SELECT id, status, builder_status, deadline_at, deadline_extensions_used,
       watchdog_consecutive_misses, watchdog_total_misses, watchdog_first_eligible_at,
       watchdog_escalated_at, completed_at
FROM estimate_runs WHERE id = '68347c15-00a0-4ecd-a614-c538fa3dd166';

\echo '=== Full event timeline including any new events ==='
SELECT created_at, from_status, to_status, detail
FROM estimate_run_events
WHERE estimate_run_id = '68347c15-00a0-4ecd-a614-c538fa3dd166'
ORDER BY created_at;

\echo '=== All pg_cron ticks from 05:33 onward ==='
SELECT created_at, duration_ms, deadlines_enforced, watchdog_escalations,
       stuck_files_retried, job_locks_reclaimed, errors
FROM intake_recovery_runs
WHERE created_at >= '2026-08-24 05:33:00+00'
ORDER BY created_at;

\echo '=== ai_operations for this job specifically, exact timestamps + duration if tracked ==='
SELECT id, scope_key, stage, created_at, cost_cents
FROM ai_operations
WHERE scope_key LIKE '%ff6c0f7f-5cd9-410c-b585-343293b41c3e%'
   OR scope_key LIKE '%c1fe6f7a-6fff-450d-873f-630b07ed44c2%'
ORDER BY created_at;

\echo '=== Quote now? ==='
SELECT id, status, total_cost, overall_confidence, (qa_report IS NOT NULL) AS has_qa
FROM quotes WHERE job_id = 'c1fe6f7a-6fff-450d-873f-630b07ed44c2';
