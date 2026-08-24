-- PostgREST-vs-direct-SQL test, step 1: create TWO fresh, disposable
-- synthetic batch+estimate_run rows, both satisfying every eligibility
-- predicate enforce_estimate_deadlines()/find_stuck_batches_needing_
-- classification_retry() check (cloned from the most recent real terminal
-- batch, same technique used for the Option D verification earlier).
--
-- ROW 1 is the DIRECT-SQL test subject: this script calls both RPC
-- functions directly against it via plain SQL and records before/after
-- state.
-- ROW 2 is left untouched here — a separate script, run through the
-- application's own PostgREST/supabase-js path (same mechanism route.ts
-- uses), will call the same two functions against it.

\echo '=== Financial-safety BEFORE snapshot (zero AI calls expected from any step of this test) ==='
SELECT count(*) AS ops_before, sum(cost_cents) AS cost_cents_before FROM ai_operations;

\echo '=== STEP 1: create ROW 1 (direct-SQL subject) and ROW 2 (PostgREST subject) ==='
WITH source_batch AS (
  SELECT b.id AS batch_id, er.id AS run_id
  FROM document_processing_batches b
  JOIN estimate_runs er ON er.batch_id = b.id
  WHERE b.status IN ('completed', 'completed_with_failures', 'failed')
  ORDER BY b.created_at DESC
  LIMIT 1
),
new_batch_1 AS (
  INSERT INTO document_processing_batches
  SELECT * FROM jsonb_populate_record(null::document_processing_batches, (
    SELECT to_jsonb(b) - 'id' || jsonb_build_object('id', gen_random_uuid()::text, 'created_at', now()::text, 'updated_at', (now() - interval '5 minutes')::text)
    FROM document_processing_batches b, source_batch sb WHERE b.id = sb.batch_id
  ))
  RETURNING id, job_id
),
new_run_1 AS (
  INSERT INTO estimate_runs
  SELECT * FROM jsonb_populate_record(null::estimate_runs, (
    SELECT to_jsonb(er) - 'id' || jsonb_build_object(
      'id', gen_random_uuid()::text, 'batch_id', (SELECT id FROM new_batch_1)::text,
      'builder_status', null, 'needs_review_reason', null, 'needs_review_reason_code', null,
      'deadline_extensions_used', 0, 'deadline_at', (now() - interval '1 minute')::text,
      'started_at', (now() - interval '16 minutes')::text, 'completed_at', null, 'reconciled_at', now()::text,
      'watchdog_first_eligible_at', null, 'watchdog_last_eligible_at', null, 'watchdog_last_attempt_at', null,
      'watchdog_consecutive_misses', 0, 'watchdog_total_misses', 0, 'watchdog_escalated_at', null, 'watchdog_escalation_reason', null
    )
    FROM estimate_runs er, source_batch sb WHERE er.id = sb.run_id
  ))
  RETURNING id, batch_id, job_id
),
new_batch_2 AS (
  INSERT INTO document_processing_batches
  SELECT * FROM jsonb_populate_record(null::document_processing_batches, (
    SELECT to_jsonb(b) - 'id' || jsonb_build_object('id', gen_random_uuid()::text, 'created_at', now()::text, 'updated_at', (now() - interval '5 minutes')::text)
    FROM document_processing_batches b, source_batch sb WHERE b.id = sb.batch_id
  ))
  RETURNING id, job_id
),
new_run_2 AS (
  INSERT INTO estimate_runs
  SELECT * FROM jsonb_populate_record(null::estimate_runs, (
    SELECT to_jsonb(er) - 'id' || jsonb_build_object(
      'id', gen_random_uuid()::text, 'batch_id', (SELECT id FROM new_batch_2)::text,
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
SELECT
  (SELECT id FROM new_batch_1) AS row1_batch_id, (SELECT id FROM new_run_1) AS row1_estimate_run_id, (SELECT job_id FROM new_run_1) AS row1_job_id,
  (SELECT id FROM new_batch_2) AS row2_batch_id, (SELECT id FROM new_run_2) AS row2_estimate_run_id, (SELECT job_id FROM new_run_2) AS row2_job_id
\gset synth_

\echo '=== STEP 2: confirm both rows are eligible (deadline passed, builder_status NULL, extension-eligible predicate true) ==='
SELECT er.id, er.batch_id, er.deadline_at, (er.deadline_at < now()) AS deadline_passed, er.builder_status,
       (b.quote_id IS NULL AND b.status IN ('completed','completed_with_failures','failed') AND b.classification_triggered
        AND b.stage3_failure_count = 0 AND b.stage6_failure_count = 0
        AND NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = b.job_id)) AS extension_eligible
FROM estimate_runs er JOIN document_processing_batches b ON b.id = er.batch_id
WHERE er.id IN (:'synth_row1_estimate_run_id', :'synth_row2_estimate_run_id');

\echo '=== IDs for the PostgREST-side script (copy these) ==='
SELECT :'synth_row1_batch_id' AS row1_batch_id, :'synth_row1_estimate_run_id' AS row1_estimate_run_id,
       :'synth_row2_batch_id' AS row2_batch_id, :'synth_row2_estimate_run_id' AS row2_estimate_run_id,
       :'synth_row2_job_id' AS row2_job_id;
