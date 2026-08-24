-- Quick read-only check: given real time has passed since the two
-- synthetic rows were created (10:44:09 deadline), production's own
-- pg_cron may have already processed them via its normal automated ticks
-- before this test's own direct-SQL/PostgREST calls could run. Check
-- current state before deciding next steps.

\echo '=== Current state of both synthetic rows ==='
SELECT id, batch_id, deadline_at, builder_status, deadline_extensions_used,
       needs_review_reason, completed_at, watchdog_consecutive_misses, watchdog_total_misses
FROM estimate_runs
WHERE id IN ('2bb7b7ca-e55e-4538-966d-901dd6ebe5fd', '81151ab0-54bc-4438-8f51-39c7c0e21a39');

\echo '=== Recent intake_recovery_runs ticks -- did the automatic cron process these? ==='
SELECT created_at, deadlines_enforced, watchdog_escalations, errors
FROM intake_recovery_runs
WHERE created_at >= '2026-08-24 10:44:00+00'
ORDER BY created_at;

\echo '=== Now() for reference ==='
SELECT now();
