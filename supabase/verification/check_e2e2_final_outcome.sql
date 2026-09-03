-- READ-ONLY. Final outcome check for the second fresh E2E job (dbcc6f7d),
-- per explicit instruction to stop investigating the recovery delay and
-- just report the final result. Zero writes.

\echo '=== batch final state ==='
SELECT id, status, updated_at, stage6_completed_trade_ids, stall_stage, quote_id
FROM document_processing_batches WHERE id = '9f14b072-5c91-4c0f-b238-adcef1a87fc8';

\echo '=== quote final state ==='
SELECT id, status, total_cost, overall_confidence, qa_report IS NOT NULL AS has_qa, created_at
FROM quotes WHERE job_id = 'dbcc6f7d-6b7c-4862-8c2c-cb96e9143bb3';

\echo '=== quote line items ==='
SELECT count(*) AS total, count(*) FILTER (WHERE rate IS NULL) AS unpriced
FROM quote_line_items
WHERE quote_id IN (SELECT id FROM quotes WHERE job_id = 'dbcc6f7d-6b7c-4862-8c2c-cb96e9143bb3');

\echo '=== estimate_run final state + full event history ==='
SELECT id, status, builder_status, started_at, completed_at
FROM estimate_runs WHERE job_id = 'dbcc6f7d-6b7c-4862-8c2c-cb96e9143bb3';

SELECT ere.created_at, ere.from_status, ere.to_status
FROM estimate_run_events ere
JOIN estimate_runs er ON er.id = ere.estimate_run_id
WHERE er.job_id = 'dbcc6f7d-6b7c-4862-8c2c-cb96e9143bb3'
ORDER BY ere.created_at ASC;

\echo '=== job_intake_locks (any manual intervention pending?) ==='
SELECT * FROM job_intake_locks WHERE job_id = 'dbcc6f7d-6b7c-4862-8c2c-cb96e9143bb3';

\echo '=== now ==='
SELECT now();
