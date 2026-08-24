-- Option D targeted production verification, step 1: read-only pre-checks.
-- Confirms (a) pg_cron is the sole automatic scheduler for the recovery
-- route, (b) the new migration 096 functions/columns are live, (c) the
-- current, real state of financial-safety counters before we touch
-- anything, so we have a clean before/after comparison.

\echo '=== 1. pg_cron: worka-intake-recovery is the only active schedule hitting this route ==='
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'worka-intake-recovery';

\echo '=== 2. Confirm no OTHER pg_cron job targets the same route/functions ==='
SELECT jobid, jobname, schedule, command, active FROM cron.job;

\echo '=== 3. Confirm migration 096 functions + columns are live ==='
SELECT proname FROM pg_proc WHERE proname IN ('record_watchdog_post_tick', 'escalate_watchdog_finalize');

SELECT column_name FROM information_schema.columns
WHERE table_name = 'estimate_runs' AND column_name LIKE 'watchdog_%'
ORDER BY column_name;

SELECT column_name FROM information_schema.columns
WHERE table_name = 'intake_recovery_runs' AND column_name LIKE 'watchdog_%'
ORDER BY column_name;

\echo '=== 4. Confirm no estimate_runs row currently has nonzero watchdog bookkeeping (clean baseline) ==='
SELECT count(*) AS rows_with_watchdog_state
FROM estimate_runs
WHERE watchdog_consecutive_misses > 0 OR watchdog_first_eligible_at IS NOT NULL;

\echo '=== 5. Baseline financial-safety snapshot (global, not scoped to any one batch) ==='
SELECT value FROM system_status WHERE key = 'ai_circuit_breaker';
SELECT count(*) AS total_ops_today, sum(cost_cents) AS total_cost_cents_today
FROM ai_operations WHERE created_at >= date_trunc('day', now());

\echo '=== 6. Recent intake_recovery_runs ticks — confirm the route is running normally right now ==='
SELECT created_at, duration_ms, deadlines_enforced, errors
FROM intake_recovery_runs
ORDER BY created_at DESC
LIMIT 5;
