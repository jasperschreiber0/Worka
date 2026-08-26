-- Phase 1 follow-up: intake_recovery_runs proves the recovery route runs
-- every minute with zero errors, yet Batch A's estimate_run
-- (c31864a1-11e4-4e5d-ae1f-149f37be45ca, deadline_at 2026-08-26 08:21:03,
-- builder_status NULL) shows watchdog_total_misses = 0 after 12+ hours of
-- continuous eligibility -- inconsistent with record_watchdog_post_tick's
-- own unconditional UPDATE predicate (deadline_at < now() AND builder_status
-- IS NULL) if it were actually running against this row every tick.
-- This isolates whether the deployed function itself is broken, by calling
-- it directly (not via the app) and observing whether Batch A's row is
-- touched. Read/write: this DOES call the real function (a legitimate,
-- idempotent, zero-Anthropic-call observability operation the recovery
-- route already calls every minute) -- not a schema change, not a new
-- mechanism, not a change to application code.

\echo '=== A. Exact deployed source of record_watchdog_post_tick ==='
SELECT pg_get_functiondef('record_watchdog_post_tick'::regproc);

\echo '=== B. Exact deployed source of enforce_estimate_deadlines ==='
SELECT pg_get_functiondef('enforce_estimate_deadlines'::regproc);

\echo '=== C. Batch A estimate_run state BEFORE the manual call ==='
SELECT id, status, builder_status, deadline_at, now() AS current_time,
       (deadline_at < now() AND builder_status IS NULL) AS predicate_should_match,
       watchdog_first_eligible_at, watchdog_consecutive_misses, watchdog_total_misses
FROM estimate_runs WHERE id = 'c31864a1-11e4-4e5d-ae1f-149f37be45ca';

\echo '=== D. Call record_watchdog_post_tick() directly -- does Batch A appear in the result set? ==='
SELECT * FROM record_watchdog_post_tick() WHERE estimate_run_id = 'c31864a1-11e4-4e5d-ae1f-149f37be45ca';

\echo '=== D2. Full result set (every row this call touched, so we know if it ran at all) ==='
SELECT count(*) AS total_rows_touched_this_call FROM record_watchdog_post_tick();

\echo '=== E. Batch A estimate_run state AFTER the manual call ==='
SELECT id, status, builder_status, deadline_at, now() AS current_time,
       watchdog_first_eligible_at, watchdog_consecutive_misses, watchdog_total_misses, watchdog_last_attempt_at
FROM estimate_runs WHERE id = 'c31864a1-11e4-4e5d-ae1f-149f37be45ca';

\echo '=== F. pg_cron job history, last 10 runs (small, safe limit) ==='
SELECT jrd.runid, jrd.status, jrd.start_time, jrd.end_time, jrd.return_message
FROM cron.job_run_details jrd
JOIN cron.job j ON j.jobid = jrd.jobid
WHERE j.jobname = 'worka-intake-recovery'
ORDER BY jrd.start_time DESC
LIMIT 10;

\echo '=== G. net._http_response, last 10 (small, safe limit) ==='
SELECT id, status_code, created, left(content::text, 300) AS response_body_truncated
FROM net._http_response
ORDER BY created DESC
LIMIT 10;

\echo '=== H. intake_recovery_runs errors -- any non-empty error array in the last 60 rows? ==='
SELECT created_at, errors
FROM intake_recovery_runs
WHERE errors IS NOT NULL AND errors != '[]'::jsonb
ORDER BY created_at DESC
LIMIT 20;

\echo '=== I. intake_recovery_runs -- deadlines_enforced/watchdog_escalations non-zero anywhere recently? ==='
SELECT created_at, deadlines_enforced, watchdog_escalations, watchdog_escalations_finalized
FROM intake_recovery_runs
WHERE (deadlines_enforced > 0 OR watchdog_escalations > 0)
  AND created_at > now() - interval '18 hours'
ORDER BY created_at DESC
LIMIT 20;
