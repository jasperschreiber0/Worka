-- Final decisive check: has Batch A's document_processing_batches row made
-- any REAL progress (stage6_completed_trade_ids, quote_id, updated_at)
-- since it was observed frozen at 2026-08-26 08:10:10 in the two prior
-- diagnostics, now that estimate_runs.deadline_at was just observed to have
-- moved forward for the first time (21:08:00, from the original 08:21:03)?
-- Also checks deadline_extensions_used, which the prior query omitted.
-- Entirely read-only.

\echo '=== 1. Batch A document_processing_batches -- has real progress happened? ==='
SELECT id, status, stall_stage, stall_reason, stalled_at, updated_at,
       stage3_completed_trade_ids, stage6_completed_trade_ids, quote_id, total_ai_call_attempts
FROM document_processing_batches
WHERE id = '0d18df41-2bc0-4e91-b9bd-a8af7fc1f18f';

\echo '=== 2. Batch A estimate_run -- full state including deadline_extensions_used ==='
SELECT id, status, builder_status, deadline_at, deadline_extensions_used, now() AS current_time,
       watchdog_first_eligible_at, watchdog_last_eligible_at, watchdog_last_attempt_at,
       watchdog_consecutive_misses, watchdog_total_misses, completed_at
FROM estimate_runs WHERE id = 'c31864a1-11e4-4e5d-ae1f-149f37be45ca';

\echo '=== 3. estimate_run_events for this run -- exact history of every extension/finalize event ==='
SELECT created_at, from_status, to_status, detail
FROM estimate_run_events
WHERE estimate_run_id = 'c31864a1-11e4-4e5d-ae1f-149f37be45ca'
ORDER BY created_at ASC;

\echo '=== 4. job_intake_locks for Batch A job right now (is a real invocation currently running?) ==='
SELECT * FROM job_intake_locks WHERE job_id = '2b22dcb5-6862-40e2-abbc-764263bf17d6';

\echo '=== 5. Total eligible-row candidate pool size RIGHT NOW (tests the SKIP LOCKED starvation theory -- a large pool is consistent with long, variable per-row latency) ==='
SELECT count(*) AS total_eligible_estimate_runs
FROM estimate_runs
WHERE deadline_at < now() AND builder_status IS NULL;

\echo '=== 6. Oldest 10 eligible rows by original staleness (first_eligible_at), to see if Batch A is typical or an outlier ==='
SELECT id, batch_id, deadline_at, deadline_extensions_used, watchdog_first_eligible_at, watchdog_total_misses
FROM estimate_runs
WHERE deadline_at < now() AND builder_status IS NULL
ORDER BY watchdog_first_eligible_at ASC NULLS LAST
LIMIT 10;
