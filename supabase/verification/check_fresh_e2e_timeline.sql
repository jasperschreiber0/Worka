-- READ-ONLY. Full timeline for the fresh E2E job (4f8824d2-5103-43e0-9e30-
-- feb5811b3214, batch 85b7a359-3388-4d73-9684-05e05ca8930b), to measure real
-- elapsed time from upload to usable estimate. Zero writes.

\echo '=== batch final state ==='
SELECT id, status, classification_triggered, quote_id, created_at, updated_at,
       scope_reasoning_completed_at, stall_stage, stalled_at, stall_count
FROM document_processing_batches
WHERE id = '85b7a359-3388-4d73-9684-05e05ca8930b';

\echo '=== document_processing_jobs (Stage 1/2 extraction) ==='
SELECT id, document_id, status, attempts, locked_at, updated_at
FROM document_processing_jobs
WHERE parent_job_id = '85b7a359-3388-4d73-9684-05e05ca8930b';

\echo '=== ai_operations for this job, in order ==='
SELECT call_site, status, error_classification, duration_ms, created_at, completed_at
FROM ai_operations
WHERE scope_key LIKE '%4f8824d2-5103-43e0-9e30-feb5811b3214%'
ORDER BY created_at ASC;

\echo '=== quote ==='
SELECT id, status, total_cost, overall_confidence, qa_report IS NOT NULL AS has_qa, created_at,
       pricing_qa_backfill_attempts, pricing_qa_backfill_claimed_at
FROM quotes
WHERE job_id = '4f8824d2-5103-43e0-9e30-feb5811b3214';

\echo '=== quote line items ==='
SELECT count(*) AS total, count(*) FILTER (WHERE rate IS NULL) AS unpriced
FROM quote_line_items
WHERE quote_id IN (SELECT id FROM quotes WHERE job_id = '4f8824d2-5103-43e0-9e30-feb5811b3214');

\echo '=== estimate_run full event history (exact transition timestamps) ==='
SELECT er.id, er.status, er.builder_status, er.started_at, er.completed_at, er.reconciled_at
FROM estimate_runs er WHERE er.job_id = '4f8824d2-5103-43e0-9e30-feb5811b3214';

SELECT ere.created_at, ere.from_status, ere.to_status, ere.detail
FROM estimate_run_events ere
JOIN estimate_runs er ON er.id = ere.estimate_run_id
WHERE er.job_id = '4f8824d2-5103-43e0-9e30-feb5811b3214'
ORDER BY ere.created_at ASC;

\echo '=== job_intake_locks (still active?) ==='
SELECT * FROM job_intake_locks WHERE job_id = '4f8824d2-5103-43e0-9e30-feb5811b3214';

\echo '=== now ==='
SELECT now();
