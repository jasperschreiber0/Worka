-- Read-only: verify the batch-level Stage 6 slot claim (migration 094) actually
-- bounded cross-invocation concurrency for job 9f08fde6 / batch f53db004, the
-- post-slot-claim-fix production reliability test run.

\echo '=== Every stage_estimate_generation ai_operations row for this job ==='
SELECT
  id, call_site, scope_key, status, created_at, completed_at,
  EXTRACT(EPOCH FROM (completed_at - created_at)) AS duration_s,
  cost_cents
FROM ai_operations
WHERE scope_key LIKE '9f08fde6-f631-4d30-b955-53c7a41166c1:%'
ORDER BY created_at;

\echo '=== Overlap check: any two stage_estimate_generation calls in flight simultaneously (max concurrency at any instant) ==='
WITH s6 AS (
  SELECT id, created_at, COALESCE(completed_at, now()) AS ends_at
  FROM ai_operations
  WHERE scope_key = '9f08fde6-f631-4d30-b955-53c7a41166c1:stage_estimate_generation'
)
SELECT a.id AS call_a, b.id AS call_b, a.created_at AS a_start, a.ends_at AS a_end,
       b.created_at AS b_start, b.ends_at AS b_end
FROM s6 a JOIN s6 b ON a.id < b.id
WHERE a.created_at < b.ends_at AND b.created_at < a.ends_at;

\echo '=== Max concurrent stage_estimate_generation calls at any single instant (sweep-line count) ==='
WITH s6 AS (
  SELECT created_at AS t, 1 AS delta
  FROM ai_operations
  WHERE scope_key = '9f08fde6-f631-4d30-b955-53c7a41166c1:stage_estimate_generation'
  UNION ALL
  SELECT COALESCE(completed_at, now()) AS t, -1 AS delta
  FROM ai_operations
  WHERE scope_key = '9f08fde6-f631-4d30-b955-53c7a41166c1:stage_estimate_generation'
)
SELECT max(running) AS max_concurrent_stage6_calls
FROM (SELECT sum(delta) OVER (ORDER BY t, delta DESC) AS running FROM s6) x;

\echo '=== Current stage6_active_calls on the batch (should reflect live/expired slots) ==='
SELECT id, stage6_active_calls, updated_at
FROM document_processing_batches
WHERE id = 'f53db004-c8a1-471e-aaa9-34abae45ceb0';

\echo '=== Batch + estimate_runs + quote current state ==='
SELECT status, classification_triggered, quote_id, stall_stage, total_ai_call_attempts, updated_at
FROM document_processing_batches WHERE id = 'f53db004-c8a1-471e-aaa9-34abae45ceb0';

SELECT status, builder_status, deadline_extensions_used, completed_at
FROM estimate_runs WHERE batch_id = 'f53db004-c8a1-471e-aaa9-34abae45ceb0';

SELECT id, status, total_cost, (qa_report IS NOT NULL) AS has_qa_report
FROM quotes WHERE job_id = '9f08fde6-f631-4d30-b955-53c7a41166c1';

SELECT count(*) AS line_items, count(*) FILTER (WHERE rate IS NOT NULL) AS priced,
       count(DISTINCT trade_category_id) AS distinct_trades
FROM quote_line_items WHERE quote_id = (SELECT id FROM quotes WHERE job_id = '9f08fde6-f631-4d30-b955-53c7a41166c1' LIMIT 1);

\echo '=== job_intake_locks (should be empty once genuinely done) ==='
SELECT * FROM job_intake_locks WHERE job_id = '9f08fde6-f631-4d30-b955-53c7a41166c1';

\echo '=== ai_circuit_breaker ==='
SELECT value FROM system_status WHERE key = 'ai_circuit_breaker';
