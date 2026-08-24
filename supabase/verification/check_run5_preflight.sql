-- Run 5 pre-flight checks (read-only). Confirms the 7 items required before
-- starting the final reliability run: migration 096 live; pg_cron sole
-- scheduler; circuit breaker untripped; no leftover synthetic verification
-- rows; clean watchdog state; 20-call AI ceiling still active in code (not
-- inspectable from SQL — confirmed separately by reading the deployed
-- source); Stage 6 concurrency cap still 2 (same caveat).

\echo '=== 1. migration 096 live: functions + columns ==='
SELECT proname FROM pg_proc WHERE proname IN ('record_watchdog_post_tick', 'escalate_watchdog_finalize');
SELECT column_name FROM information_schema.columns
WHERE table_name = 'estimate_runs' AND column_name LIKE 'watchdog_%'
ORDER BY column_name;

\echo '=== 2. pg_cron: sole active schedule ==='
SELECT jobid, jobname, schedule, active FROM cron.job;

\echo '=== 2b. Confirm the GitHub Actions 5-min scheduler is still workflow_dispatch-only (no schedule) — file-level check happens outside SQL, this just documents intent ==='
SELECT 'see .github/workflows/intake-recovery-cron.yml — workflow_dispatch only, verified via lib/intake-recovery-scheduler.test.ts' AS note;

\echo '=== 3. Circuit breaker state ==='
SELECT value FROM system_status WHERE key = 'ai_circuit_breaker';

\echo '=== 4. Leftover synthetic verification rows (any batch/run for the test builder that is NOT terminal) ==='
SELECT b.id AS batch_id, b.status AS batch_status, b.created_at,
       er.id AS estimate_run_id, er.builder_status, er.deadline_at
FROM document_processing_batches b
JOIN jobs j ON j.id = b.job_id
LEFT JOIN estimate_runs er ON er.batch_id = b.id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
  AND (er.builder_status IS NULL OR b.status NOT IN ('completed', 'completed_with_failures', 'failed'))
ORDER BY b.created_at DESC;

\echo '=== 4b. Full inventory of test-builder batches (terminal or not), for context ==='
SELECT b.id AS batch_id, b.status, b.created_at, er.builder_status
FROM document_processing_batches b
JOIN jobs j ON j.id = b.job_id
LEFT JOIN estimate_runs er ON er.batch_id = b.id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY b.created_at DESC
LIMIT 20;

\echo '=== 5. Production watchdog state clean (no row currently mid-miss-tracking) ==='
SELECT count(*) AS rows_with_watchdog_state
FROM estimate_runs
WHERE watchdog_consecutive_misses > 0 OR watchdog_first_eligible_at IS NOT NULL OR watchdog_escalated_at IS NOT NULL;

SELECT id, watchdog_consecutive_misses, watchdog_total_misses, watchdog_first_eligible_at, watchdog_escalated_at
FROM estimate_runs
WHERE watchdog_consecutive_misses > 0 OR watchdog_first_eligible_at IS NOT NULL OR watchdog_escalated_at IS NOT NULL;

\echo '=== 6/7 caveat: AI ceiling + Stage 6 concurrency cap are code constants, not DB state — confirming no eligible/non-terminal batch is currently mid-run that could race Run 5 ==='
SELECT count(*) AS other_non_terminal_batches_right_now
FROM document_processing_batches
WHERE status NOT IN ('completed', 'completed_with_failures', 'failed');

\echo '=== Baseline financial snapshot immediately before Run 5 starts ==='
SELECT count(*) AS ops_before_run5, sum(cost_cents) AS cost_cents_before_run5, max(created_at) AS last_op_at
FROM ai_operations;

\echo '=== Recent recovery-cron ticks — confirm healthy right now ==='
SELECT created_at, duration_ms, deadlines_enforced, errors
FROM intake_recovery_runs
ORDER BY created_at DESC
LIMIT 5;
