-- Forensic investigation of the ~30-minute recovery gap (05:02:18Z stall ->
-- 05:34:00Z recovery) for batch ff6c0f7f-5cd9-410c-b585-343293b41c3e /
-- estimate_run 68347c15-00a0-4ecd-a614-c538fa3dd166 / job
-- c1fe6f7a-6fff-450d-873f-630b07ed44c2 / file
-- 28b8a758-daac-4dd9-9d19-2744ab00330f. Entirely read-only.

\echo '=== 1a. pg_cron.job_run_details -- EVERY job, full window, start+end+status+return_message ==='
SELECT jrd.runid, j.jobname, jrd.status, jrd.start_time, jrd.end_time,
       (jrd.end_time - jrd.start_time) AS duration, jrd.return_message
FROM cron.job_run_details jrd
JOIN cron.job j ON j.jobid = jrd.jobid
WHERE jrd.start_time BETWEEN '2026-08-24 05:04:00+00' AND '2026-08-24 05:35:00+00'
ORDER BY jrd.start_time;

\echo '=== 1b. Self-overlap check across this exact window ==='
WITH ticks AS (
  SELECT jrd.runid, jrd.start_time, jrd.end_time,
         LAG(jrd.end_time) OVER (ORDER BY jrd.start_time) AS prev_end_time,
         LAG(jrd.runid) OVER (ORDER BY jrd.start_time) AS prev_runid
  FROM cron.job_run_details jrd
  JOIN cron.job j ON j.jobid = jrd.jobid
  WHERE j.jobname = 'worka-intake-recovery'
    AND jrd.start_time BETWEEN '2026-08-24 05:04:00+00' AND '2026-08-24 05:35:00+00'
)
SELECT runid, prev_runid, start_time, prev_end_time, (prev_end_time - start_time) AS overlap_amount
FROM ticks
WHERE prev_end_time IS NOT NULL AND start_time < prev_end_time;

\echo '=== 1c. pg_cron job definition + active state right now ==='
SELECT jobid, jobname, schedule, command, active, nodename, nodeport, database, username
FROM cron.job WHERE jobname = 'worka-intake-recovery';

\echo '=== 1d. net._http_response -- actual outbound HTTP request/response timing for this window ==='
SELECT id, status_code, created,
       (content::text) AS response_body_truncated
FROM net._http_response
WHERE created BETWEEN '2026-08-24 05:04:00+00' AND '2026-08-24 05:35:00+00'
ORDER BY created;

\echo '=== 1e. intake_recovery_runs full detail, this exact window, EVERY column ==='
SELECT *
FROM intake_recovery_runs
WHERE created_at BETWEEN '2026-08-24 05:04:00+00' AND '2026-08-24 05:35:00+00'
ORDER BY created_at;

\echo '=== 2. Recovery chain -- re-derive eligibility exactly as find_stuck_batches_needing_classification_retry would have, at each known tick boundary, using ACTUAL historical updated_at (only current value available -- no history table -- but predicate components that do NOT change over time are checked here) ==='
SELECT b.id, b.status, b.classification_triggered, b.updated_at,
       (b.status IN ('completed','completed_with_failures','failed')) AS status_ok,
       b.classification_triggered AS classification_ok,
       NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = b.job_id) AS no_lock_now
FROM document_processing_batches b
WHERE b.id = 'ff6c0f7f-5cd9-410c-b585-343293b41c3e';

\echo '=== 3a. record_watchdog_post_tick -- every function with this name, in every schema (duplicate-name check) ==='
SELECT p.oid, n.nspname AS schema, p.proname, p.prosecdef AS security_definer,
       p.proconfig AS search_path_config, p.provolatile, p.pronargs,
       pg_get_function_identity_arguments(p.oid) AS args,
       r.rolname AS owner
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE p.proname = 'record_watchdog_post_tick';

\echo '=== 3b. escalate_watchdog_finalize -- same duplicate-name check ==='
SELECT p.oid, n.nspname AS schema, p.proname, p.prosecdef AS security_definer,
       p.proconfig AS search_path_config, r.rolname AS owner
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE p.proname = 'escalate_watchdog_finalize';

\echo '=== 3c. Exact deployed source of record_watchdog_post_tick right now (re-confirm, byte for byte) ==='
SELECT pg_get_functiondef('record_watchdog_post_tick'::regproc);

\echo '=== 3d. RLS status + policies on estimate_runs (does RLS matter for the role executing this RPC?) ==='
SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'estimate_runs'::regclass;

SELECT polname, polcmd, polroles::regrole[], polqual IS NOT NULL AS has_using, polwithcheck IS NOT NULL AS has_check
FROM pg_policy WHERE polrelid = 'estimate_runs'::regclass;

\echo '=== 3e. Does service_role (or whatever role PostgREST/the RPC call actually runs as) have BYPASSRLS? ==='
SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('service_role', 'authenticator', 'postgres', 'anon');

\echo '=== 3f. pg_stat_statements -- if enabled, PROVES actual call counts for record_watchdog_post_tick vs enforce_estimate_deadlines over any tracked window (best available direct-execution-count evidence) ==='
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_stat_statements';

SELECT calls, total_exec_time, mean_exec_time, rows, query
FROM pg_stat_statements
WHERE query ILIKE '%record_watchdog_post_tick%' OR query ILIKE '%enforce_estimate_deadlines%'
   OR query ILIKE '%find_stuck_batches_needing_classification_retry%'
ORDER BY calls DESC
LIMIT 20;

\echo '=== 4a. Migration application history -- exact timestamps migration 095/096 (watchdog) were actually applied to THIS database ==='
SELECT version, name, statements IS NOT NULL AS has_statements
FROM supabase_migrations.schema_migrations
WHERE version IN ('095', '096') OR name ILIKE '%watchdog%' OR name ILIKE '%deadlines_enforced%'
ORDER BY version;

\echo '=== 4b. All schema_migrations applied today, in order, with any timestamp column available ==='
SELECT * FROM supabase_migrations.schema_migrations
ORDER BY version DESC
LIMIT 15;

\echo '=== 4c. Function last-modified evidence: pg_proc has no direct timestamp, but object OID ordering + a description/comment date, if any, is the closest proxy. Also check DDL event trigger log if present. ==='
SELECT p.oid, p.proname, obj_description(p.oid, 'pg_proc') AS comment
FROM pg_proc p WHERE p.proname IN ('record_watchdog_post_tick', 'escalate_watchdog_finalize', 'enforce_estimate_deadlines');

\echo '=== 5a. ALL locks currently held anywhere in the database (not just estimate_runs) -- best-effort, current snapshot only (locks from 05:05-05:34 are gone by now, but a CURRENTLY stuck pattern would still show) ==='
SELECT l.locktype, l.relation::regclass AS relation, l.mode, l.granted, l.pid,
       a.state, a.wait_event_type, a.wait_event, a.query_start, now() - a.query_start AS query_age,
       left(a.query, 200) AS query
FROM pg_locks l
LEFT JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.pid IS DISTINCT FROM pg_backend_pid()
ORDER BY a.query_start NULLS LAST;

\echo '=== 5b. Advisory locks specifically ==='
SELECT * FROM pg_locks WHERE locktype = 'advisory';

\echo '=== 5c. Long-running / idle-in-transaction sessions right now ==='
SELECT pid, state, xact_start, now() - xact_start AS xact_age, query_start, left(query,200) AS query
FROM pg_stat_activity
WHERE state IN ('idle in transaction', 'idle in transaction (aborted)')
   OR (xact_start IS NOT NULL AND now() - xact_start > interval '2 minutes');

\echo '=== 5d. Blocked queries right now (pg_blocking_pids) ==='
SELECT pid, wait_event_type, wait_event, left(query,200) AS query, pg_blocking_pids(pid) AS blocked_by
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0;

\echo '=== 5e. Connection count / pool saturation signal ==='
SELECT count(*) AS total_connections, count(*) FILTER (WHERE state = 'active') AS active,
       count(*) FILTER (WHERE state = 'idle') AS idle,
       count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_txn
FROM pg_stat_activity;

SELECT setting AS max_connections FROM pg_settings WHERE name = 'max_connections';

\echo '=== 6. Current full row state for exact-timestamp reconstruction (deadline_at/updated_at/stalled_at/all watchdog fields/all files fields) ==='
SELECT er.id, er.status, er.builder_status, er.deadline_at, er.deadline_extensions_used,
       er.watchdog_first_eligible_at, er.watchdog_last_eligible_at, er.watchdog_last_attempt_at,
       er.watchdog_consecutive_misses, er.watchdog_total_misses, er.watchdog_escalated_at,
       er.completed_at
FROM estimate_runs er WHERE er.id = '68347c15-00a0-4ecd-a614-c538fa3dd166';

SELECT b.id, b.status, b.stall_stage, b.stalled_at, b.updated_at, b.classification_triggered
FROM document_processing_batches b WHERE b.id = 'ff6c0f7f-5cd9-410c-b585-343293b41c3e';

SELECT f.id, f.intake_status, f.intake_recovery_attempts, f.ai_failure_count, f.updated_at
FROM files f WHERE f.id = '28b8a758-daac-4dd9-9d19-2744ab00330f';

\echo '=== 7. Confirm exact route.ts RPC call spelling vs deployed function name (case/typo check via information_schema, not pg_proc, to catch any casing issue PostgREST would surface) ==='
SELECT routine_name, routine_type, specific_schema
FROM information_schema.routines
WHERE routine_name ILIKE '%watchdog%' OR routine_name ILIKE '%stuck_batches%' OR routine_name ILIKE '%enforce_estimate_deadlines%'
ORDER BY routine_name;

\echo '=== 8. PostgREST schema cache reload history -- was a reload in flight during this window that could have made the RPC briefly unreachable? (best-effort: check for any very recent NOTIFY-triggering migration around this window) ==='
SELECT version, name FROM supabase_migrations.schema_migrations
WHERE version::int >= 90
ORDER BY version;
