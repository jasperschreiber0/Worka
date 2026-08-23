-- Read-only: full verification for one reliability-test run, scoped to
-- the most recent job for the multi-trade test builder. Re-run after
-- each of the 5 test runs (each creates a new job, so "most recent" is
-- always the run just completed, as long as this is run promptly after).

\echo '=== Most recent job for builder 00000000-0000-0000-0000-0000000000fd ==='
SELECT id, address, status, created_at
FROM jobs
WHERE builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY created_at DESC
LIMIT 1;

\echo '=== Batch checkpoint state (Stage1/2, Stage3, Stage6) ==='
SELECT b.id, b.status, b.classification_triggered, b.quote_id,
       b.stall_stage, b.stall_reason, b.stall_count,
       array_length(b.stage3_completed_trade_ids, 1) AS stage3_trades_done,
       array_length(b.stage6_completed_trade_ids, 1) AS stage6_trades_done,
       b.stage3_failure_count, b.stage6_failure_count, b.total_ai_call_attempts,
       b.created_at, b.updated_at
FROM document_processing_batches b
JOIN jobs j ON j.id = b.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY b.created_at DESC
LIMIT 1;

\echo '=== job_intake_locks (must be empty once genuinely done) ==='
SELECT l.job_id, l.file_id, l.started_at, l.last_progress_at
FROM job_intake_locks l
JOIN jobs j ON j.id = l.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY l.started_at DESC;

\echo '=== estimate_runs + full event history for the most recent run ==='
SELECT er.id, er.status, er.builder_status, er.needs_review_reason, er.needs_review_reason_code,
       er.deadline_extensions_used, er.completed_at
FROM estimate_runs er
JOIN jobs j ON j.id = er.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY er.started_at DESC
LIMIT 1;

\echo '=== DUPLICATE CHECK: quote count for the most recent job (must be exactly 1) ==='
SELECT q.job_id, count(*) AS quote_count, array_agg(q.id) AS quote_ids, array_agg(q.status) AS statuses
FROM quotes q
WHERE q.job_id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1)
GROUP BY q.job_id;

\echo '=== Full quote row ==='
SELECT q.id, q.status, q.total_cost, q.margin_pct, q.confidence_score, q.overall_confidence,
       (q.qa_report IS NOT NULL) AS has_qa_report,
       q.qa_report -> 'top_risks' AS qa_top_risks,
       q.price_coverage_pct, q.pricing_match_rate_pct,
       q.pricing_qa_backfill_attempts
FROM quotes q
WHERE q.job_id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1)
ORDER BY q.created_at DESC;

\echo '=== Line items: count, priced count, distinct trades ==='
SELECT count(*) AS total_line_items,
       count(*) FILTER (WHERE total IS NOT NULL) AS priced_line_items,
       count(DISTINCT trade_category_id) AS distinct_trades
FROM quote_line_items qli
WHERE qli.quote_id IN (
  SELECT id FROM quotes WHERE job_id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1)
);

\echo '=== DUPLICATE CHECK: any trade+description pair appearing more than once ==='
SELECT qli.trade_category_id, qli.description, count(*) AS occurrences
FROM quote_line_items qli
WHERE qli.quote_id IN (
  SELECT id FROM quotes WHERE job_id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1)
)
GROUP BY qli.trade_category_id, qli.description
HAVING count(*) > 1;

\echo '=== files row ==='
SELECT f.id, f.intake_status, f.intake_stage, f.intake_pct, f.failure_stage, f.failure_reason,
       f.ai_failure_count, f.ai_failure_classification, f.intake_recovery_attempts
FROM files f
WHERE f.job_id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1);

\echo '=== intake_recovery_runs in the last 20 minutes (retry-churn signal) ==='
SELECT id, created_at, document_jobs_reclaimed, job_locks_reclaimed, stuck_files_retried,
       abandoned_files_marked_failed, files_permanently_failed, errors
FROM intake_recovery_runs
WHERE created_at > now() - interval '20 minutes'
ORDER BY created_at DESC
LIMIT 20;

\echo '=== system_status.ai_circuit_breaker ==='
SELECT key, value FROM system_status WHERE key = 'ai_circuit_breaker';
