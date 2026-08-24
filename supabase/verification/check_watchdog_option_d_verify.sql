-- Option D targeted production verification (single self-contained run):
-- creates a disposable synthetic expired batch/estimate_run, directly
-- exercises record_watchdog_post_tick + escalate_watchdog_finalize against
-- it (simulating "normal selection missed this row 30 times" by writing
-- the exact bookkeeping record_watchdog_post_tick itself would have
-- produced after 30 real ticks -- the SQL function's own decision logic is
-- exercised for real via the live escalate_watchdog_finalize call, only
-- the 30-tick wait is skipped), proves idempotency (second call is a
-- no-op), proves zero Anthropic spend throughout, then cleans up. All
-- statements run sequentially (autocommit) so every step's output is
-- individually visible in the log, matching this session's established
-- diagnostic style.

\echo '=== STEP 0: pre-check — confirm no synthetic residue from a prior run ==='
SELECT count(*) AS existing_test_batches
FROM document_processing_batches b
JOIN jobs j ON j.id = b.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd';

\echo '=== STEP 0b: financial-safety BEFORE snapshot ==='
SELECT count(*) AS ops_before, sum(cost_cents) AS cost_cents_before FROM ai_operations;
SELECT value FROM system_status WHERE key = 'ai_circuit_breaker';

\echo '=== STEP 1: create the disposable synthetic batch + estimate_run, cloned from the most recent real terminal batch (dynamic, no hardcoded id) ==='
WITH source_batch AS (
  SELECT b.id AS batch_id, er.id AS run_id
  FROM document_processing_batches b
  JOIN estimate_runs er ON er.batch_id = b.id
  WHERE b.status IN ('completed', 'completed_with_failures', 'failed')
  ORDER BY b.created_at DESC
  LIMIT 1
),
new_batch AS (
  INSERT INTO document_processing_batches
  SELECT * FROM jsonb_populate_record(null::document_processing_batches, (
    SELECT to_jsonb(b) - 'id' || jsonb_build_object(
      'id', gen_random_uuid()::text,
      'created_at', now()::text,
      'updated_at', now()::text
    )
    FROM document_processing_batches b, source_batch sb WHERE b.id = sb.batch_id
  ))
  RETURNING id, job_id
),
new_run AS (
  INSERT INTO estimate_runs
  SELECT * FROM jsonb_populate_record(null::estimate_runs, (
    SELECT to_jsonb(er) - 'id' || jsonb_build_object(
      'id', gen_random_uuid()::text,
      'batch_id', (SELECT id FROM new_batch)::text,
      'builder_status', null,
      'needs_review_reason', null,
      'needs_review_reason_code', null,
      'deadline_extensions_used', 3,
      'deadline_at', (now() - interval '35 minutes')::text,
      'started_at', (now() - interval '50 minutes')::text,
      'completed_at', null,
      'reconciled_at', now()::text,
      'watchdog_first_eligible_at', null,
      'watchdog_last_eligible_at', null,
      'watchdog_last_attempt_at', null,
      'watchdog_consecutive_misses', 0,
      'watchdog_total_misses', 0,
      'watchdog_escalated_at', null,
      'watchdog_escalation_reason', null
    )
    FROM estimate_runs er, source_batch sb WHERE er.id = sb.run_id
  ))
  RETURNING id, batch_id, deadline_at, job_id, builder_status
)
SELECT nb.id AS synthetic_batch_id, nr.id AS synthetic_estimate_run_id, nr.job_id, nr.deadline_at, nr.builder_status
FROM new_batch nb, new_run nr \gset synth_

\echo '=== STEP 2: confirm the synthetic row is eligible right now (deadline passed, builder_status NULL) — this is what a real pg_cron tick would see ==='
SELECT id, deadline_at, (deadline_at < now()) AS deadline_passed, builder_status, deadline_extensions_used
FROM estimate_runs WHERE id = :'synth_synthetic_estimate_run_id';

\echo '=== STEP 3: call the REAL record_watchdog_post_tick() — this is the exact function pg_cron-triggered ticks call. It correctly picks up our synthetic row as freshly eligible (consecutive_misses becomes 1, not 30 yet) ==='
SELECT * FROM record_watchdog_post_tick() WHERE estimate_run_id = :'synth_synthetic_estimate_run_id';

\echo '=== STEP 4: simulate "normal selection missed this row 29 MORE times" by directly writing the bookkeeping record_watchdog_post_tick itself would have produced after 29 further ticks (skips the 29-minute wait; the finalize call in STEP 6 below is the real function under real test, not simulated) ==='
UPDATE estimate_runs
SET watchdog_consecutive_misses = 30,
    watchdog_total_misses = 30,
    watchdog_first_eligible_at = now() - interval '30 minutes',
    watchdog_last_eligible_at = now() - interval '1 minute',
    watchdog_last_attempt_at = now() - interval '1 minute'
WHERE id = :'synth_synthetic_estimate_run_id'
RETURNING id, watchdog_consecutive_misses, watchdog_total_misses, watchdog_first_eligible_at;

\echo '=== STEP 5: confirm this now crosses WATCHDOG_ESCALATION_THRESHOLD_MISSES (30) per the deployed decision thresholds (lib/estimating/watchdog-escalation.ts) ==='
SELECT watchdog_consecutive_misses, (watchdog_consecutive_misses >= 30) AS would_escalate
FROM estimate_runs WHERE id = :'synth_synthetic_estimate_run_id';

\echo '=== STEP 6: call the REAL escalate_watchdog_finalize() — this is the actual production fallback function, under real test, not simulated ==='
SELECT * FROM escalate_watchdog_finalize(:'synth_synthetic_estimate_run_id');

\echo '=== STEP 7: verify terminal state was reached ==='
SELECT id, builder_status, needs_review_reason, completed_at, watchdog_escalated_at, watchdog_escalation_reason
FROM estimate_runs WHERE id = :'synth_synthetic_estimate_run_id';

\echo '=== STEP 8: verify the estimate_run_events audit row was written ==='
SELECT from_status, to_status, detail
FROM estimate_run_events
WHERE estimate_run_id = :'synth_synthetic_estimate_run_id'
ORDER BY created_at DESC
LIMIT 3;

\echo '=== STEP 9 (Test D/E — idempotency): call escalate_watchdog_finalize a SECOND time on the now-terminal row — must be a safe no-op (escalated=false), must NOT write a second estimate_run_events row, must NOT change builder_status/completed_at ==='
SELECT * FROM escalate_watchdog_finalize(:'synth_synthetic_estimate_run_id');

SELECT count(*) AS estimate_run_events_count
FROM estimate_run_events WHERE estimate_run_id = :'synth_synthetic_estimate_run_id';

SELECT id, builder_status, completed_at, watchdog_escalated_at
FROM estimate_runs WHERE id = :'synth_synthetic_estimate_run_id';

\echo '=== STEP 10: confirm no duplicate quote/line-items were created for this synthetic job by either escalation call ==='
SELECT count(*) AS quotes_for_synthetic_job
FROM quotes WHERE job_id = :'synth_job_id';

\echo '=== STEP 11: financial-safety AFTER snapshot — must be IDENTICAL to the BEFORE snapshot (zero Anthropic calls made by any step above) ==='
SELECT count(*) AS ops_after, sum(cost_cents) AS cost_cents_after FROM ai_operations;
SELECT value FROM system_status WHERE key = 'ai_circuit_breaker';

\echo '=== STEP 12: confirm pg_cron is still the sole scheduler and normal watchdog selection was not disturbed by any of the above (a real tick could have fired concurrently; confirm no error) ==='
SELECT created_at, duration_ms, deadlines_enforced, errors
FROM intake_recovery_runs
ORDER BY created_at DESC
LIMIT 3;

\echo '=== STEP 13: cleanup — delete the disposable synthetic batch (cascades to estimate_runs + estimate_run_events) ==='
DELETE FROM document_processing_batches WHERE id = :'synth_synthetic_batch_id' RETURNING id;

\echo '=== STEP 14: confirm cleanup is complete — zero synthetic rows remain ==='
SELECT count(*) AS remaining_synthetic_batches
FROM document_processing_batches WHERE id = :'synth_synthetic_batch_id';
SELECT count(*) AS remaining_synthetic_runs
FROM estimate_runs WHERE id = :'synth_synthetic_estimate_run_id';
