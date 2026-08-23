-- Creates a DISPOSABLE, already-expired, non-extension-eligible
-- document_processing_batches + estimate_runs row pair, cloned from Run
-- 3's real batch/run (bdeca4fa / 826ffcee) via jsonb_populate_record so
-- every column matches a real production row's shape exactly, with only
-- the fields that define eligibility overridden:
--   - deadline_at in the past (now() - 1 minute) -> immediately eligible
--   - builder_status NULL, deadline_extensions_used 0 -> not yet finalized
--   - stage3_failure_count/quote_id are copied as-is from bdeca4fa
--     (1 and NULL respectively) -- this is exactly what made the original
--     row non-extension-eligible per migration 089's predicate.
-- Reuses the existing test job (89b77f76) rather than creating a new one.
-- estimate_runs has ON DELETE CASCADE from document_processing_batches,
-- and estimate_run_events has ON DELETE CASCADE from estimate_runs, so
-- cleanup is a single DELETE on the batch row (see the cleanup script).

WITH new_batch AS (
  INSERT INTO document_processing_batches
  SELECT * FROM jsonb_populate_record(null::document_processing_batches, (
    SELECT to_jsonb(b) - 'id' || jsonb_build_object(
      'id', gen_random_uuid()::text,
      'created_at', now()::text,
      'updated_at', now()::text
    )
    FROM document_processing_batches b WHERE b.id = 'bdeca4fa-4f36-4e95-b87a-4fb063724fde'
  ))
  RETURNING id
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
      'deadline_extensions_used', 0,
      'deadline_at', (now() - interval '1 minute')::text,
      'started_at', (now() - interval '16 minutes')::text,
      'completed_at', null,
      'reconciled_at', now()::text
    )
    FROM estimate_runs er WHERE er.id = '826ffcee-d1b7-45bf-8431-5630ba85d358'
  ))
  RETURNING id, batch_id, deadline_at, job_id
)
SELECT nb.id AS synthetic_batch_id, nr.id AS synthetic_estimate_run_id, nr.job_id, nr.deadline_at, now() AS created_at
FROM new_batch nb, new_run nr;
