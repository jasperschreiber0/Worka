-- READ-ONLY. Batch 9f14b072 (job dbcc6f7d) is now well past its 3-minute
-- grace period (stalled 09:19:32, grace clears 09:22:32) but 6+ recovery
-- ticks since then still report batches_resumed=0. Evaluate every clause of
-- find_stuck_batches_needing_classification_retry's predicate directly,
-- including stage3/6 failure counts and AI-failure state not checked in the
-- prior diagnostic. Zero writes.

\echo '=== full batch row ==='
SELECT * FROM document_processing_batches WHERE id = '9f14b072-5c91-4c0f-b238-adcef1a87fc8';

\echo '=== per-clause evaluation ==='
SELECT
  b.status IN ('completed', 'completed_with_failures', 'failed') AS status_terminal,
  b.classification_triggered AS classification_triggered,
  b.updated_at < now() - interval '3 minutes' AS past_grace_period,
  b.stage3_failure_count = 0 AS stage3_failure_count_zero,
  b.stage3_failure_count AS stage3_failure_count_value,
  b.stage6_failure_count = 0 AS stage6_failure_count_zero,
  b.stage6_failure_count AS stage6_failure_count_value,
  NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = b.job_id) AS no_job_intake_lock,
  NOT EXISTS (SELECT 1 FROM estimate_runs er WHERE er.batch_id = b.id AND er.builder_status IS NOT NULL) AS no_finalized_estimate_run,
  NOT EXISTS (
    SELECT 1 FROM document_processing_jobs j
    JOIN files f ON f.id = j.document_id
    WHERE j.parent_job_id = b.id
      AND f.ai_failure_count > 0
      AND NOT EXISTS (SELECT 1 FROM project_documents pd WHERE pd.file_id = f.id AND pd.extraction_status = 'complete')
  ) AS no_unresolved_ai_failure
FROM document_processing_batches b
WHERE b.id = '9f14b072-5c91-4c0f-b238-adcef1a87fc8';

\echo '=== is this batch actually returned by the live RPC right now? ==='
SELECT * FROM find_stuck_batches_needing_classification_retry();

\echo '=== how many total rows does the RPC return right now (backlog size)? ==='
SELECT count(*) FROM find_stuck_batches_needing_classification_retry();

\echo '=== files + ai_failure state for this batch job ==='
SELECT f.id, f.intake_status, f.ai_failure_classification, f.ai_failure_count
FROM files f WHERE f.job_id = 'dbcc6f7d-6b7c-4862-8c2c-cb96e9143bb3';

\echo '=== document_processing_jobs for this batch ==='
SELECT id, document_id, status, attempts FROM document_processing_jobs
WHERE parent_job_id = '9f14b072-5c91-4c0f-b238-adcef1a87fc8';

\echo '=== now ==='
SELECT now();
