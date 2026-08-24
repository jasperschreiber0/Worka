-- Anomaly investigation (read-only, no writes, no function calls that
-- mutate anything): estimate_runs 68347c15-00a0-4ecd-a614-c538fa3dd166 has
-- been deadline_at-overdue for 20+ minutes across 21+ real pg_cron ticks,
-- yet enforce_estimate_deadlines() has not extended/finalized it AND the
-- new record_watchdog_post_tick() has not incremented its miss counters
-- even once, despite that function using plain UPDATEs with no FOR UPDATE/
-- SKIP LOCKED (so it should never be "skipped" by contention the way the
-- SKIP LOCKED loop can be). This checks whether the row actually matches
-- the literal WHERE predicate right now, the exact type/value of
-- builder_status, and whether any lock is currently held on this specific
-- row.

\echo '=== Exact predicate match, computed the same way both functions compute it ==='
SELECT id,
       deadline_at,
       now() AS now_value,
       (deadline_at < now()) AS deadline_lt_now,
       builder_status,
       (builder_status IS NULL) AS builder_status_is_null,
       pg_typeof(builder_status) AS builder_status_type,
       length(builder_status) AS builder_status_length,
       (deadline_at < now() AND builder_status IS NULL) AS full_predicate_match
FROM estimate_runs
WHERE id = '68347c15-00a0-4ecd-a614-c538fa3dd166';

\echo '=== Does a plain SELECT with the identical WHERE clause both functions use return this row RIGHT NOW? ==='
SELECT id, deadline_at, builder_status
FROM estimate_runs
WHERE deadline_at < now() AND builder_status IS NULL
  AND id = '68347c15-00a0-4ecd-a614-c538fa3dd166';

\echo '=== Any lock currently held on THIS SPECIFIC ROW (ctid-based) or the estimate_runs relation generally ==='
SELECT l.locktype, l.mode, l.granted, l.pid, a.state, a.query, now() - a.xact_start AS xact_age
FROM pg_locks l
LEFT JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.relation = 'estimate_runs'::regclass;

\echo '=== Deployed function source for both functions, confirm the WHERE clauses actually deployed match what we expect ==='
SELECT pg_get_functiondef('enforce_estimate_deadlines'::regproc);

\echo '=== ==='
SELECT pg_get_functiondef('record_watchdog_post_tick'::regproc);

\echo '=== How many estimate_runs rows total right now match the eligibility predicate (across ALL jobs, not just Run 5) -- is this an isolated case or systemic? ==='
SELECT count(*) AS total_eligible_rows_right_now
FROM estimate_runs
WHERE deadline_at < now() AND builder_status IS NULL;

SELECT id, job_id, deadline_at, now() - deadline_at AS overdue_by, builder_status, watchdog_consecutive_misses
FROM estimate_runs
WHERE deadline_at < now() AND builder_status IS NULL
ORDER BY deadline_at;

\echo '=== Sanity: has record_watchdog_post_tick been successfully returning ANY rows on ANY tick recently, for ANY job (not just Run 5)? Re-derive from intake_recovery_runs watchdog columns history ==='
SELECT created_at, watchdog_escalations, watchdog_escalations_finalized, deadlines_enforced
FROM intake_recovery_runs
WHERE created_at >= '2026-08-24 04:54:00+00'
ORDER BY created_at;
