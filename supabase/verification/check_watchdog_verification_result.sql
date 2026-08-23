-- Verification: did pg_cron alone (no redundant GitHub Actions scheduler)
-- finalize the disposable expired batch created for the targeted watchdog
-- test? batch_id=6b5762c2-5593-4ca9-a1c2-bfe2ed90b3ee,
-- estimate_run_id=5beb3013-34f8-4c99-88bc-8112436b1079,
-- job_id=89b77f76-7cb3-427d-ae81-919ea2320c35, deadline_at=22:59:21.903182+00.

\echo '=== Synthetic estimate_runs row: builder_status/completed_at now ==='
SELECT id, status, builder_status, needs_review_reason, needs_review_reason_code,
       deadline_at, completed_at, (completed_at - deadline_at) AS finalized_after
FROM estimate_runs
WHERE id = '5beb3013-34f8-4c99-88bc-8112436b1079';

\echo '=== estimate_run_events for this synthetic run (should show deadline_enforced if finalized) ==='
SELECT created_at, from_status, to_status, detail
FROM estimate_run_events
WHERE estimate_run_id = '5beb3013-34f8-4c99-88bc-8112436b1079'
ORDER BY created_at;

\echo '=== intake_recovery_runs since the deadline (22:59:00), including the new deadlines_enforced column ==='
SELECT created_at, deadlines_enforced, document_jobs_reclaimed, errors
FROM intake_recovery_runs
WHERE created_at >= '2026-08-23 22:59:00+00'
ORDER BY created_at;

\echo '=== ai_operations count/cost for job 89b77f76 vs baseline (2 ops, $0.1167 -- must be unchanged) ==='
SELECT count(*) AS total_ops, sum(cost_cents) AS total_cost_cents
FROM ai_operations
WHERE scope_key LIKE '89b77f76-7cb3-427d-ae81-919ea2320c35:%';

\echo '=== Synthetic batch: total_ai_call_attempts unchanged? ==='
SELECT total_ai_call_attempts, stage6_active_calls, updated_at
FROM document_processing_batches
WHERE id = '6b5762c2-5593-4ca9-a1c2-bfe2ed90b3ee';

\echo '=== pg_cron ticks since the deadline (confirms the sole scheduler kept firing) ==='
SELECT jrd.runid, jrd.status, jrd.start_time
FROM cron.job_run_details jrd
JOIN cron.job j ON j.jobid = jrd.jobid
WHERE j.jobname = 'worka-intake-recovery'
  AND jrd.start_time >= '2026-08-23 22:59:00+00'
ORDER BY jrd.start_time;
