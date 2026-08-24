-- PostgREST-vs-direct-SQL test, Phase 1 (direct SQL): create ONE fresh
-- disposable synthetic row, explicitly forced to be genuinely
-- extension-eligible (quote_id NULL, stage3/stage6 failure counts 0,
-- matching Run 5's real predicate shape), then IMMEDIATELY call both
-- recovery functions directly via SQL in the same script execution to
-- minimize the race window against the next pg_cron tick. Since these
-- functions are global (no per-row filter), only ONE synthetic row exists
-- at a time in this phase -- Phase 2 (PostgREST path) creates its own
-- separate row afterward, once this one is already resolved/cleaned up.

\echo '=== Financial-safety BEFORE snapshot ==='
SELECT count(*) AS ops_before, sum(cost_cents) AS cost_cents_before FROM ai_operations;

\echo '=== Create ROW 1 (direct-SQL subject), explicitly extension-eligible ==='
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
      'id', gen_random_uuid()::text, 'created_at', now()::text, 'updated_at', (now() - interval '5 minutes')::text,
      'quote_id', null, 'stage3_failure_count', 0, 'stage6_failure_count', 0,
      'status', 'completed', 'classification_triggered', true
    )
    FROM document_processing_batches b, source_batch sb WHERE b.id = sb.batch_id
  ))
  RETURNING id, job_id
),
new_run AS (
  INSERT INTO estimate_runs
  SELECT * FROM jsonb_populate_record(null::estimate_runs, (
    SELECT to_jsonb(er) - 'id' || jsonb_build_object(
      'id', gen_random_uuid()::text, 'batch_id', (SELECT id FROM new_batch)::text,
      'builder_status', null, 'needs_review_reason', null, 'needs_review_reason_code', null,
      'deadline_extensions_used', 0, 'deadline_at', (now() - interval '1 minute')::text,
      'started_at', (now() - interval '16 minutes')::text, 'completed_at', null, 'reconciled_at', now()::text,
      'watchdog_first_eligible_at', null, 'watchdog_last_eligible_at', null, 'watchdog_last_attempt_at', null,
      'watchdog_consecutive_misses', 0, 'watchdog_total_misses', 0, 'watchdog_escalated_at', null, 'watchdog_escalation_reason', null
    )
    FROM estimate_runs er, source_batch sb WHERE er.id = sb.run_id
  ))
  RETURNING id, batch_id, job_id
)
SELECT id AS row1_estimate_run_id, batch_id AS row1_batch_id, job_id AS row1_job_id FROM new_run
\gset row1_

\echo '=== Confirm ROW 1 is genuinely extension-eligible ==='
SELECT er.id, er.deadline_at, (er.deadline_at < now()) AS deadline_passed, er.builder_status,
       (b.quote_id IS NULL AND b.status IN ('completed','completed_with_failures','failed') AND b.classification_triggered
        AND b.stage3_failure_count = 0 AND b.stage6_failure_count = 0
        AND NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = b.job_id)) AS extension_eligible
FROM estimate_runs er JOIN document_processing_batches b ON b.id = er.batch_id
WHERE er.id = :'row1_row1_estimate_run_id';

\echo '=== BEFORE state ==='
SELECT id, deadline_at, deadline_extensions_used, builder_status, watchdog_consecutive_misses, watchdog_total_misses
FROM estimate_runs WHERE id = :'row1_row1_estimate_run_id';

\echo '=== CALL 1 (direct SQL): enforce_estimate_deadlines() -- full result set ==='
SELECT * FROM enforce_estimate_deadlines();

\echo '=== CALL 2 (direct SQL): find_stuck_batches_needing_classification_retry() -- full result set ==='
SELECT * FROM find_stuck_batches_needing_classification_retry();

\echo '=== AFTER state ==='
SELECT id, deadline_at, deadline_extensions_used, builder_status, completed_at, needs_review_reason,
       watchdog_consecutive_misses, watchdog_total_misses
FROM estimate_runs WHERE id = :'row1_row1_estimate_run_id';

\echo '=== Financial-safety AFTER snapshot (must be identical -- zero Anthropic calls from either function) ==='
SELECT count(*) AS ops_after, sum(cost_cents) AS cost_cents_after FROM ai_operations;

\echo '=== IDs for reference/cleanup ==='
SELECT :'row1_row1_batch_id' AS row1_batch_id, :'row1_row1_estimate_run_id' AS row1_estimate_run_id;
