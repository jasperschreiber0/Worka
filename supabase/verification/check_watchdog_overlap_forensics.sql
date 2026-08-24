-- Forensic investigation: what actually competes with enforce_estimate_deadlines()
-- for Run 4's row during the 2+ hour window it sat non-terminal
-- (deadline_at originally 23:40:40, extended once to 01:49:00, still
-- non-terminal as of this query). Read-only throughout.

\echo '=== 1. intake_recovery_runs: EVERY tick since 23:40, full timing + all counts, to find overlap and slow invocations ==='
SELECT created_at AS run_started_at, duration_ms,
       (created_at + (duration_ms || ' milliseconds')::interval) AS computed_finish,
       deadlines_enforced, document_jobs_reclaimed, stalled_batches_recomputed,
       batches_resumed, stale_locks_released, abandoned_files_marked_failed,
       job_locks_reclaimed, stuck_files_retried, files_permanently_failed, errors
FROM intake_recovery_runs
WHERE created_at >= '2026-08-23 23:40:00+00'
ORDER BY created_at;

\echo '=== 2. Does the pg_cron job_run_details table have BOTH start_time and end_time? Full columns ==='
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'cron' AND table_name = 'job_run_details';

\echo '=== 3. pg_cron tick history since 23:40 with start_time AND end_time -- look for overlapping windows ==='
SELECT jrd.runid, jrd.status, jrd.start_time, jrd.end_time,
       (jrd.end_time - jrd.start_time) AS tick_duration
FROM cron.job_run_details jrd
JOIN cron.job j ON j.jobid = jrd.jobid
WHERE j.jobname = 'worka-intake-recovery'
  AND jrd.start_time >= '2026-08-23 23:40:00+00'
ORDER BY jrd.start_time;

\echo '=== 4. Self-overlap check: any pg_cron tick whose start_time is BEFORE the previous ticks end_time? ==='
WITH ticks AS (
  SELECT jrd.runid, jrd.start_time, jrd.end_time,
         LAG(jrd.end_time) OVER (ORDER BY jrd.start_time) AS prev_end_time,
         LAG(jrd.runid) OVER (ORDER BY jrd.start_time) AS prev_runid
  FROM cron.job_run_details jrd
  JOIN cron.job j ON j.jobid = jrd.jobid
  WHERE j.jobname = 'worka-intake-recovery'
    AND jrd.start_time >= '2026-08-23 23:40:00+00'
)
SELECT runid, prev_runid, start_time, prev_end_time,
       (prev_end_time - start_time) AS overlap_amount
FROM ticks
WHERE prev_end_time IS NOT NULL AND start_time < prev_end_time
ORDER BY start_time;

\echo '=== 5. pg_net _http_response log for the actual outbound HTTP calls in this window (actual request/response timing, not just the enqueue) ==='
SELECT id, status_code, created
FROM net._http_response
WHERE created >= '2026-08-23 23:40:00+00'
ORDER BY created
LIMIT 200;

\echo '=== 6. Any OTHER pg_cron jobs scheduled that could also touch estimate_runs (not just worka-intake-recovery) ==='
SELECT jobid, jobname, schedule, command, active
FROM cron.job;

\echo '=== 7. Any database triggers on estimate_runs itself ==='
SELECT tgname, tgrelid::regclass, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid = 'estimate_runs'::regclass AND NOT tgisinternal;

\echo '=== 8. reconcile_estimate_run live function body -- confirm it writes to estimate_runs and could hold a lock ==='
SELECT pg_get_functiondef('reconcile_estimate_run'::regproc);

\echo '=== 9. find_stuck_batches_needing_classification_retry live body -- any LIMIT/candidate cap that could starve Run 4 across ticks? ==='
SELECT pg_get_functiondef('find_stuck_batches_needing_classification_retry'::regproc);

\echo '=== 10. Exact tick where Run 4 was extended: find the intake_recovery_runs row whose window covers ~01:43 (deadline_at moved to 01:49:00, i.e. now()+6min at extension time) ==='
SELECT created_at, duration_ms, deadlines_enforced
FROM intake_recovery_runs
WHERE created_at BETWEEN '2026-08-24 01:40:00+00' AND '2026-08-24 01:46:00+00'
ORDER BY created_at;

\echo '=== 11. Financial safety re-confirm ==='
SELECT total_ai_call_attempts, stage6_active_calls, updated_at
FROM document_processing_batches WHERE id = '9c124f0e-b03c-4666-9b15-4f2426a35718';

SELECT count(*) AS total_ops, sum(cost_cents) AS total_cost_cents, max(created_at) AS last_call_at
FROM ai_operations
WHERE scope_key LIKE '58b4eef0-78c2-4f48-ac74-c566ac81801f:%';

SELECT value FROM system_status WHERE key = 'ai_circuit_breaker';

\echo '=== 12. Current estimate_runs state, one more time, fresh ==='
SELECT id, status, builder_status, deadline_extensions_used, deadline_at, now() - deadline_at AS overdue_by
FROM estimate_runs WHERE id = 'f0a1bd1a-63b3-4e7a-8822-705569d94f1f';
