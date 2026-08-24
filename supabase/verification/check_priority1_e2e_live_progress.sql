-- Read-only live-progress check for the Priority 1 (immediate self-retrigger)
-- controlled end-to-end verification. Reserved test builder
-- 00000000-0000-0000-0000-0000000000fd (run-multitrade-known-good-estimate.mjs).

\echo '=== Most recent job for the multitrade test builder ==='
SELECT id AS job_id, job_ref, created_at, status
FROM jobs
WHERE builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY created_at DESC
LIMIT 1;

\echo '=== Most recent document_processing_batches row for that job ==='
SELECT b.id AS batch_id, b.job_id, b.status, b.classification_triggered,
       b.scope_reasoning_completed_at, b.stage3_completed_trade_ids,
       array_length(b.stage3_completed_trade_ids, 1) AS stage3_trades_done,
       b.stage6_completed_trade_ids,
       array_length(b.stage6_completed_trade_ids, 1) AS stage6_trades_done,
       b.stall_stage, b.stall_reason, b.stall_count, b.stalled_at,
       b.total_ai_call_attempts, b.quote_id,
       b.created_at, b.updated_at
FROM document_processing_batches b
JOIN jobs j ON j.id = b.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY b.created_at DESC
LIMIT 1;

\echo '=== job_intake_locks currently held for this job (should be none once handed off) ==='
SELECT l.*
FROM job_intake_locks l
JOIN jobs j ON j.id = l.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd';

\echo '=== estimate_runs row for this batch ==='
SELECT er.id, er.batch_id, er.builder_status, er.needs_review_reason,
       er.started_at, er.deadline_at, er.completed_at,
       er.watchdog_consecutive_misses, er.watchdog_total_misses
FROM estimate_runs er
JOIN document_processing_batches b ON b.id = er.batch_id
JOIN jobs j ON j.id = b.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY er.started_at DESC
LIMIT 1;

\echo '=== Quote for this job (pricing/QA) ==='
SELECT q.id AS quote_id, q.status, q.total_cost, q.overall_confidence,
       (q.qa_report IS NOT NULL) AS has_qa_report, q.created_at, q.updated_at
FROM quotes q
JOIN jobs j ON j.id = q.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY q.created_at DESC
LIMIT 1;

\echo '=== quote_line_items count + distinct trades for this quote ==='
SELECT count(*) AS line_item_count, count(DISTINCT trade_category_id) AS distinct_trades
FROM quote_line_items
WHERE quote_id = (
  SELECT q.id FROM quotes q JOIN jobs j ON j.id = q.job_id
  WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
  ORDER BY q.created_at DESC LIMIT 1
);

\echo '=== Any duplicate (quote_id, trade_category_id, description) -- must be zero rows ==='
SELECT quote_id, trade_category_id, description, count(*)
FROM quote_line_items
WHERE quote_id = (
  SELECT q.id FROM quotes q JOIN jobs j ON j.id = q.job_id
  WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
  ORDER BY q.created_at DESC LIMIT 1
)
GROUP BY quote_id, trade_category_id, description
HAVING count(*) > 1;

\echo '=== ai_operations count/cost for this job (circuit breaker / ceiling sanity) ==='
SELECT count(*) AS ops_count, sum(cost_cents) AS cost_cents
FROM ai_operations
WHERE job_id = (
  SELECT j.id FROM jobs j WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
  ORDER BY j.created_at DESC LIMIT 1
);

\echo '=== system_status ai_circuit_breaker current value ==='
SELECT key, value FROM system_status WHERE key = 'ai_circuit_breaker';

\echo '=== intake_recovery_runs in the last 15 minutes -- did the cron do anything for this batch? ==='
SELECT created_at, deadlines_enforced, document_jobs_reclaimed, job_locks_reclaimed,
       stuck_files_retried, watchdog_escalations, errors
FROM intake_recovery_runs
WHERE created_at >= now() - interval '15 minutes'
ORDER BY created_at;

\echo '=== now() for reference ==='
SELECT now();
