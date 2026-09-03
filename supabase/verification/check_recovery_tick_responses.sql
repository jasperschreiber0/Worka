-- READ-ONLY. Batch 9f14b072 became recovery-eligible at 09:22:32 but the
-- first successful retrigger (stuck_files_retried=1) didn't land until the
-- 09:29:00 tick -- 6 prior ticks (09:23-09:28) each completed in ~0.3-0.5s
-- (run_finished_at - run_started_at), too fast to have made the real DB
-- round-trips + outbound fetch that a genuine retry would need. This pulls
-- the ACTUAL pg_net HTTP response body/status for each of those ticks
-- directly, to see what the live route actually said/did, cutting through
-- guesswork. Zero writes.

\echo '=== pg_cron job config for the intake-recovery trigger ==='
SELECT jobid, schedule, command, active FROM cron.job WHERE command ILIKE '%intake_recovery%' OR command ILIKE '%trigger_intake_recovery%';

\echo '=== cron.job_run_details for the relevant window ==='
SELECT jobid, runid, status, return_message, start_time, end_time
FROM cron.job_run_details
WHERE start_time BETWEEN '2026-09-03 09:21:00+00' AND '2026-09-03 09:30:00+00'
ORDER BY start_time ASC;

\echo '=== net._http_response for the relevant window (actual HTTP responses pg_net received) ==='
SELECT id, status_code, created, LEFT(content::text, 500) AS body_preview
FROM net._http_response
WHERE created BETWEEN '2026-09-03 09:21:00+00' AND '2026-09-03 09:30:00+00'
ORDER BY created ASC;

\echo '=== now ==='
SELECT now();
