-- Run 5 post-stall check (read-only). The harness's own 15-min timeout
-- fired at 05:11:44 UTC while the batch was cleanly stalled at
-- "generating_estimate" (Stage 6 not yet started, Stage 3 fully complete).
-- This checks whether PRODUCTION's own automatic recovery mechanisms
-- (pg_cron -> intake-recovery route, independent of the harness's own
-- reconnect-triggered calls) have since picked the batch back up, and
-- whether the new watchdog (migration 096) has started tracking it.

\echo '=== Batch current state ==='
SELECT id, status, stall_stage, stall_reason, stall_count, stalled_at,
       total_ai_call_attempts, classification_triggered, quote_id,
       scope_reasoning_completed_at, stage6_active_calls,
       stage3_completed_trade_ids, stage6_completed_trade_ids,
       created_at, updated_at
FROM document_processing_batches
WHERE id = 'ff6c0f7f-5cd9-410c-b585-343293b41c3e';

\echo '=== job_intake_locks for this job — is anything currently running? ==='
SELECT * FROM job_intake_locks WHERE job_id = 'c1fe6f7a-6fff-450d-873f-630b07ed44c2';

\echo '=== files.intake_recovery_attempts / ai_failure state for this file ==='
SELECT id, intake_status, failure_stage, failure_reason, ai_failure_count,
       ai_failure_classification, intake_recovery_attempts
FROM files
WHERE id = '28b8a758-daac-4dd9-9d19-2744ab00330f';

\echo '=== estimate_runs current state, including watchdog bookkeeping ==='
SELECT id, status, builder_status, needs_review_reason, deadline_at, now() - deadline_at AS overdue_by,
       deadline_extensions_used,
       watchdog_first_eligible_at, watchdog_last_eligible_at, watchdog_last_attempt_at,
       watchdog_consecutive_misses, watchdog_total_misses, watchdog_escalated_at, watchdog_escalation_reason,
       completed_at
FROM estimate_runs
WHERE id = '68347c15-00a0-4ecd-a614-c538fa3dd166';

\echo '=== estimate_run_events for this run — full timeline ==='
SELECT created_at, from_status, to_status, detail
FROM estimate_run_events
WHERE estimate_run_id = '68347c15-00a0-4ecd-a614-c538fa3dd166'
ORDER BY created_at;

\echo '=== Does find_stuck_batches_needing_classification_retry currently return this batch? (read-only call, does not itself trigger anything) ==='
SELECT * FROM find_stuck_batches_needing_classification_retry()
WHERE batch_id = 'ff6c0f7f-5cd9-410c-b585-343293b41c3e';

\echo '=== Real pg_cron ticks since the harness gave up (05:11:44), independent of the harness own recovery_triggered calls ==='
SELECT created_at, duration_ms, deadlines_enforced, watchdog_escalations,
       stuck_files_retried, job_locks_reclaimed, errors
FROM intake_recovery_runs
WHERE created_at >= '2026-08-24 05:11:44+00'
ORDER BY created_at;

\echo '=== AI spend now vs Run 5 baseline (4382 ops / 3166.26 cost_cents) ==='
SELECT count(*) AS ops_now, sum(cost_cents) AS cost_cents_now, max(created_at) AS last_op_at
FROM ai_operations;

SELECT count(*) AS ops_since_run5_started
FROM ai_operations WHERE created_at >= '2026-08-24 04:56:00+00';

\echo '=== Circuit breaker ==='
SELECT value FROM system_status WHERE key = 'ai_circuit_breaker';

\echo '=== Quote (if any exists now) ==='
SELECT id, status, total_cost, overall_confidence, (qa_report IS NOT NULL) AS has_qa
FROM quotes WHERE job_id = 'c1fe6f7a-6fff-450d-873f-630b07ed44c2';
