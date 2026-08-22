-- Read-only diagnostic: is the pg_cron-based intake-recovery scheduler
-- (migration 038/041/044) actually scheduled, enabled, and firing?
-- Never touches or prints secret VALUES -- only whether a name exists in
-- Vault. Run via: psql "$SUPABASE_DB_URL" -f this_file.sql

\echo '=== 1. Is the pg_cron job scheduled, and is it enabled? ==='
SELECT jobid, schedule, command, nodename, nodeport, database, username, active
FROM cron.job
WHERE jobname = 'worka-intake-recovery';

\echo '=== 2. Last 10 pg_cron run attempts for this job (did it actually fire, and what happened) ==='
SELECT jrd.runid, jrd.job_pid, jrd.status, jrd.return_message, jrd.start_time, jrd.end_time
FROM cron.job_run_details jrd
JOIN cron.job j ON j.jobid = jrd.jobid
WHERE j.jobname = 'worka-intake-recovery'
ORDER BY jrd.start_time DESC
LIMIT 10;

\echo '=== 3. Cadence: gaps between the last 20 scheduled fire times ==='
SELECT jrd.start_time,
       jrd.start_time - LAG(jrd.start_time) OVER (ORDER BY jrd.start_time) AS gap_since_prior
FROM cron.job_run_details jrd
JOIN cron.job j ON j.jobid = jrd.jobid
WHERE j.jobname = 'worka-intake-recovery'
ORDER BY jrd.start_time DESC
LIMIT 20;

\echo '=== 4. Are the two required Vault secrets present (name only, never the value)? ==='
SELECT name, created_at, updated_at
FROM vault.secrets
WHERE name IN ('worka_app_url', 'worka_cron_secret');

\echo '=== 5. Does trigger_intake_recovery() see them via vault.decrypted_secrets (the exact view the function reads)? ==='
SELECT name, (decrypted_secret IS NOT NULL) AS decrypts_ok, length(decrypted_secret) AS secret_length
FROM vault.decrypted_secrets
WHERE name IN ('worka_app_url', 'worka_cron_secret');

\echo '=== 6. Recent pg_net HTTP responses for calls this function made (status code visible, body may be large) ==='
SELECT id, status_code, created, (content IS NOT NULL) AS has_body, error_msg
FROM net._http_response
ORDER BY created DESC
LIMIT 10;

\echo '=== 7. Application-level record: intake_recovery_runs -- last 10 runs, whichever trigger source called the route ==='
SELECT id, created_at, duration_ms, document_jobs_reclaimed, job_locks_reclaimed,
       files_permanently_failed, stale_locks_released, abandoned_files_marked_failed, errors
FROM intake_recovery_runs
ORDER BY created_at DESC
LIMIT 10;

\echo '=== 8. Time since the most recent intake_recovery_runs row, and the gap distribution over the last 50 ==='
SELECT now() - MAX(created_at) AS time_since_last_run FROM intake_recovery_runs;
SELECT created_at, created_at - LAG(created_at) OVER (ORDER BY created_at) AS gap_since_prior
FROM (SELECT created_at FROM intake_recovery_runs ORDER BY created_at DESC LIMIT 50) recent
ORDER BY created_at DESC;
