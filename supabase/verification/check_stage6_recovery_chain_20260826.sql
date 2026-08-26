-- Phase 1 diagnosis: why the automatic recovery mechanism did not resume two
-- real production batches that stalled at Stage 6 (generating_estimate) with
-- wall-clock deferral. Entirely read-only. Adapted from the query set used
-- in check_run5_recovery_gap_forensics.sql for a prior, similar incident.
--
-- Batch A: 0d18df41-2bc0-4e91-b9bd-a8af7fc1f18f / job 2b22dcb5-6862-40e2-abbc-764263bf17d6
--          / file 643fea3b-8b61-4c4f-bf33-d284c3ecbe15 / estimate_run c31864a1-11e4-4e5d-ae1f-149f37be45ca
--          stalled_at 2026-08-26T08:10:10Z
-- Batch B: d4701fc1-f4be-4f75-9eb4-cf031f66cb33 / job 231f2747-38a8-44d0-a8c5-ef883a2830ab
--          stalled_at 2026-08-26T02:26:58Z (approx, from the run that stalled it)

\echo '=== 0. Current time (for window math) ==='
SELECT now();

\echo '=== 1a. pg_cron job definition + active state right now ==='
SELECT jobid, jobname, schedule, command, active, nodename, nodeport, database, username
FROM cron.job WHERE jobname = 'worka-intake-recovery';

\echo '=== 1b. pg_cron.job_run_details -- full window covering both batches, start+end+status+return_message ==='
SELECT jrd.runid, j.jobname, jrd.status, jrd.start_time, jrd.end_time,
       (jrd.end_time - jrd.start_time) AS duration, jrd.return_message
FROM cron.job_run_details jrd
JOIN cron.job j ON j.jobid = jrd.jobid
WHERE j.jobname = 'worka-intake-recovery'
  AND jrd.start_time BETWEEN '2026-08-26 02:00:00+00' AND now()
ORDER BY jrd.start_time DESC
LIMIT 50;

\echo '=== 1c. Total run count + last run time (proves whether pg_cron has been firing AT ALL recently) ==='
SELECT count(*) AS total_runs_in_window,
       max(jrd.start_time) AS most_recent_run,
       now() - max(jrd.start_time) AS time_since_last_run
FROM cron.job_run_details jrd
JOIN cron.job j ON j.jobid = jrd.jobid
WHERE j.jobname = 'worka-intake-recovery';

\echo '=== 2. net._http_response -- actual outbound HTTP request/response timing for this window ==='
SELECT id, status_code, created,
       left(content::text, 500) AS response_body_truncated
FROM net._http_response
WHERE created BETWEEN '2026-08-26 02:00:00+00' AND now()
ORDER BY created DESC
LIMIT 50;

\echo '=== 3. intake_recovery_runs full detail, this window, EVERY column ==='
SELECT *
FROM intake_recovery_runs
WHERE created_at BETWEEN '2026-08-26 02:00:00+00' AND now()
ORDER BY created_at DESC;

\echo '=== 4a. Vault secrets -- do worka_app_url / worka_cron_secret actually exist? (names only, never the decrypted value) ==='
SELECT name, created_at, updated_at FROM vault.secrets WHERE name IN ('worka_app_url', 'worka_cron_secret');

\echo '=== 4b. Are they actually decryptable right now (proves the vault key itself works, not just that a row exists) -- length only, never the real value ==='
SELECT name, length(decrypted_secret) AS decrypted_length, created_at
FROM vault.decrypted_secrets WHERE name IN ('worka_app_url', 'worka_cron_secret');

\echo '=== 5a. Batch A -- current state, and re-derived eligibility exactly as find_stuck_batches_needing_classification_retry computes it ==='
SELECT b.id, b.status, b.stall_stage, b.stall_reason, b.stalled_at, b.updated_at, b.classification_triggered,
       b.stage3_completed_trade_ids, b.stage6_completed_trade_ids, b.quote_id,
       (b.status IN ('completed','completed_with_failures','failed')) AS status_ok,
       b.classification_triggered AS classification_ok,
       (b.updated_at < now() - interval '3 minutes') AS grace_elapsed,
       NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = b.job_id) AS no_lock_now
FROM document_processing_batches b
WHERE b.id = '0d18df41-2bc0-4e91-b9bd-a8af7fc1f18f';

SELECT * FROM find_stuck_batches_needing_classification_retry() WHERE batch_id = '0d18df41-2bc0-4e91-b9bd-a8af7fc1f18f';

\echo '=== 5b. Batch A -- estimate_run + watchdog bookkeeping ==='
SELECT er.id, er.status, er.builder_status, er.deadline_at, er.deadline_extensions_used,
       er.watchdog_first_eligible_at, er.watchdog_last_eligible_at, er.watchdog_last_attempt_at,
       er.watchdog_consecutive_misses, er.watchdog_total_misses, er.watchdog_escalated_at,
       er.watchdog_escalation_reason, er.completed_at, er.needs_review_reason
FROM estimate_runs er WHERE er.id = 'c31864a1-11e4-4e5d-ae1f-149f37be45ca';

\echo '=== 5c. Batch A -- file recovery-attempt bookkeeping ==='
SELECT f.id, f.intake_status, f.intake_recovery_attempts, f.ai_failure_classification, f.ai_failure_count,
       f.failure_stage, f.failure_reason, f.updated_at
FROM files f WHERE f.id = '643fea3b-8b61-4c4f-bf33-d284c3ecbe15';

\echo '=== 5d. Batch A -- job_intake_locks history (currently held? ever held since stall?) ==='
SELECT * FROM job_intake_locks WHERE job_id = '2b22dcb5-6862-40e2-abbc-764263bf17d6';

\echo '=== 6a. Batch B -- current state + eligibility ==='
SELECT b.id, b.status, b.stall_stage, b.stall_reason, b.stalled_at, b.updated_at, b.classification_triggered,
       b.stage3_completed_trade_ids, b.stage6_completed_trade_ids, b.quote_id,
       (b.status IN ('completed','completed_with_failures','failed')) AS status_ok,
       b.classification_triggered AS classification_ok,
       (b.updated_at < now() - interval '3 minutes') AS grace_elapsed,
       NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = b.job_id) AS no_lock_now
FROM document_processing_batches b
WHERE b.id = 'd4701fc1-f4be-4f75-9eb4-cf031f66cb33';

SELECT * FROM find_stuck_batches_needing_classification_retry() WHERE batch_id = 'd4701fc1-f4be-4f75-9eb4-cf031f66cb33';

\echo '=== 6b. Batch B -- estimate_run + watchdog bookkeeping (look up by batch_id, id unknown) ==='
SELECT er.id, er.status, er.builder_status, er.deadline_at, er.deadline_extensions_used,
       er.watchdog_first_eligible_at, er.watchdog_last_eligible_at, er.watchdog_last_attempt_at,
       er.watchdog_consecutive_misses, er.watchdog_total_misses, er.watchdog_escalated_at,
       er.watchdog_escalation_reason, er.completed_at, er.needs_review_reason
FROM estimate_runs er WHERE er.batch_id = 'd4701fc1-f4be-4f75-9eb4-cf031f66cb33';

\echo '=== 6c. Batch B -- job_intake_locks history ==='
SELECT * FROM job_intake_locks WHERE job_id = '231f2747-38a8-44d0-a8c5-ef883a2830ab';

\echo '=== 7. Function existence + exact deployed signature sanity check (case/typo/duplicate check) ==='
SELECT routine_name, routine_type, specific_schema
FROM information_schema.routines
WHERE routine_name IN ('trigger_intake_recovery', 'record_watchdog_post_tick', 'escalate_watchdog_finalize',
                        'find_stuck_batches_needing_classification_retry', 'enforce_estimate_deadlines',
                        'acquire_or_reclaim_job_intake_lock')
ORDER BY routine_name;

\echo '=== 8. Currently blocked queries / long-running transactions (could a live lock be silently starving the cron tick?) ==='
SELECT pid, wait_event_type, wait_event, left(query,200) AS query, pg_blocking_pids(pid) AS blocked_by
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0;

SELECT pid, state, xact_start, now() - xact_start AS xact_age, query_start, left(query,200) AS query
FROM pg_stat_activity
WHERE state IN ('idle in transaction', 'idle in transaction (aborted)')
   OR (xact_start IS NOT NULL AND now() - xact_start > interval '2 minutes');

\echo '=== 9. system_status / circuit breaker (rule out a global block) ==='
SELECT key, value, updated_at FROM system_status WHERE key IN ('ai_circuit_breaker', 'ai_limits');
