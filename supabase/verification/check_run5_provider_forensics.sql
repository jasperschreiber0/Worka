-- Provider/tier forensics for the Run 5 recovery gap. Read-only.
-- Checks: Postgres restart signal, connection/resource tier signals,
-- exact ai_operations activity (or lack thereof) inside the gap window,
-- pg_stat_statements reset time (to calibrate the 108/103/8 call-count
-- comparison from the prior forensic pass).

\echo '=== 1. Postgres server start time -- did Postgres itself restart during or near the gap (05:02:18 - 05:34:30)? ==='
SELECT pg_postmaster_start_time(), now() - pg_postmaster_start_time() AS uptime;

\echo '=== 2. Connection / resource tier signals ==='
SELECT name, setting, unit FROM pg_settings
WHERE name IN ('max_connections', 'shared_buffers', 'effective_cache_size', 'work_mem',
               'maintenance_work_mem', 'max_worker_processes', 'max_parallel_workers',
               'max_parallel_workers_per_gather', 'max_wal_size', 'shared_preload_libraries')
ORDER BY name;

\echo '=== 3. pg_stat_statements reset/stats-since time (calibrates the earlier 108 vs 103 vs 8 call-count comparison) ==='
SELECT stats_reset FROM pg_stat_statements_info;

\echo '=== 4. ai_operations -- EVERY row touching this job/batch, or created in the exact gap window, whichever is broader ==='
SELECT id, scope_key, created_at, cost_cents
FROM ai_operations
WHERE created_at BETWEEN '2026-08-24 04:55:00+00' AND '2026-08-24 05:36:00+00'
ORDER BY created_at;

\echo '=== 5. Global ai_operations count/cost exactly bounding the gap window (04:58:35 last known call -> 05:34:03 next known activity) ==='
SELECT count(*) AS ops_in_gap_window, sum(cost_cents) AS cost_in_gap_window
FROM ai_operations
WHERE created_at > '2026-08-24 04:58:35+00' AND created_at < '2026-08-24 05:34:03+00';

\echo '=== 6. system_status ai_circuit_breaker -- current value + confirm untripped throughout (cross-checked against every net._http_response body already captured, this is just the current DB value) ==='
SELECT key, value FROM system_status WHERE key IN ('ai_circuit_breaker', 'ai_limits');

\echo '=== 7. Any Postgres-visible error/warning signal for this exact window -- pg_stat_database error-adjacent counters (best-effort; Supabase does not expose postgres log lines via SQL) ==='
SELECT datname, xact_commit, xact_rollback, deadlocks, conflicts, temp_files, temp_bytes, stats_reset
FROM pg_stat_database WHERE datname = current_database();

\echo '=== 8. Table/index bloat or autovacuum activity on estimate_runs/document_processing_batches around this time (a heavy autovacuum could theoretically cause brief query delays, though not a 30-min gap) ==='
SELECT relname, last_autovacuum, last_autoanalyze, n_dead_tup, n_live_tup
FROM pg_stat_user_tables
WHERE relname IN ('estimate_runs', 'document_processing_batches', 'job_intake_locks', 'files');

\echo '=== 9. Current database size (rough tier signal) ==='
SELECT pg_size_pretty(pg_database_size(current_database()));

\echo '=== 10. Any currently-visible extension related to compute/resource monitoring that hints at plan tier ==='
SELECT extname, extversion FROM pg_extension ORDER BY extname;
