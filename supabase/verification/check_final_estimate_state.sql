-- Read-only: final end-to-end state for the most recent multi-trade test
-- job (builder_id 00000000-0000-0000-0000-0000000000fd). Checks every
-- claim required for a genuine ESTIMATE_READY verdict directly from
-- Supabase -- never inferred from logs, HTTP status, or retry counters.

\echo '=== Most recent job for this test builder ==='
SELECT id, address, status, created_at
FROM jobs
WHERE builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY created_at DESC
LIMIT 1;

\echo '=== document_processing_batches for the most recent job ==='
SELECT b.id, b.status, b.classification_triggered, b.quote_id,
       b.stall_stage, b.stall_reason, b.stalled_at, b.stall_count,
       b.scope_reasoning_completed_at,
       array_length(b.stage3_completed_trade_ids, 1) AS stage3_trades_done,
       array_length(b.stage6_completed_trade_ids, 1) AS stage6_trades_done,
       b.stage3_failure_count, b.stage6_failure_count, b.total_ai_call_attempts,
       b.updated_at, b.created_at
FROM document_processing_batches b
JOIN jobs j ON j.id = b.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY b.created_at DESC
LIMIT 1;

\echo '=== job_intake_locks (should be empty once genuinely done) ==='
SELECT l.job_id, l.file_id, l.started_at, l.last_progress_at, now() - l.last_progress_at AS stale_for
FROM job_intake_locks l
JOIN jobs j ON j.id = l.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY l.started_at DESC;

\echo '=== estimate_runs -- builder_status is the ESTIMATE_READY signal ==='
SELECT er.id, er.job_id, er.batch_id, er.status, er.builder_status, er.needs_review_reason,
       er.deadline_at, er.deadline_extensions_used, er.lock_held, er.stall_reason, er.failure_reason,
       er.started_at, er.last_progress_at, er.completed_at
FROM estimate_runs er
JOIN jobs j ON j.id = er.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY er.started_at DESC
LIMIT 1;

\echo '=== estimate_run_events -- full state transition history for the most recent run ==='
SELECT ere.from_status, ere.to_status, ere.detail, ere.created_at
FROM estimate_run_events ere
JOIN estimate_runs er ON er.id = ere.estimate_run_id
JOIN jobs j ON j.id = er.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
  AND er.id = (
    SELECT id FROM estimate_runs er2 JOIN jobs j2 ON j2.id = er2.job_id
    WHERE j2.builder_id = '00000000-0000-0000-0000-0000000000fd'
    ORDER BY er2.started_at DESC LIMIT 1
  )
ORDER BY ere.created_at ASC;

\echo '=== DUPLICATE CHECK: how many quotes exist for this job? (must be exactly 1) ==='
SELECT q.job_id, count(*) AS quote_count, array_agg(q.id) AS quote_ids, array_agg(q.status) AS statuses
FROM quotes q
JOIN jobs j ON j.id = q.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
  AND j.id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1)
GROUP BY q.job_id;

\echo '=== Full quote row -- total_cost, margin_pct, confidence, qa_report presence ==='
SELECT q.id, q.job_id, q.status, q.total_cost, q.margin_pct, q.confidence_score,
       q.overall_confidence, (q.qa_report IS NOT NULL) AS has_qa_report,
       q.qa_report -> 'top_risks' AS qa_top_risks,
       q.qa_report -> 'missing_trades' AS qa_missing_trades,
       q.price_coverage_pct, q.pricing_match_rate_pct, q.document_contribution IS NOT NULL AS has_document_contribution
FROM quotes q
JOIN jobs j ON j.id = q.job_id
WHERE j.id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1)
ORDER BY q.created_at DESC;

\echo '=== Line items: count, priced count, distinct trades, computed client price ==='
SELECT
  count(*) AS total_line_items,
  count(*) FILTER (WHERE qli.total IS NOT NULL) AS priced_line_items,
  count(DISTINCT qli.trade_category_id) AS distinct_trades,
  round(sum(coalesce(qli.total, 0) * (1 + coalesce(qli.margin_pct, 0)))::numeric, 2) AS computed_client_price_ex_gst
FROM quote_line_items qli
JOIN quotes q ON q.id = qli.quote_id
WHERE q.job_id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1);

\echo '=== DUPLICATE CHECK: any trade+description pair appearing more than once on the current quote? ==='
SELECT qli.trade_category_id, qli.description, count(*) AS occurrences
FROM quote_line_items qli
JOIN quotes q ON q.id = qli.quote_id
WHERE q.job_id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1)
GROUP BY qli.trade_category_id, qli.description
HAVING count(*) > 1;

\echo '=== files row -- intake_status, failure info ==='
SELECT f.id, f.job_id, f.intake_status, f.intake_stage, f.intake_pct, f.failure_stage, f.failure_reason,
       f.quote_id, f.processing_batch_id
FROM files f
WHERE f.job_id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1);

\echo '=== Recent intake_recovery_runs (last 20 min) ==='
SELECT id, created_at, duration_ms, document_jobs_reclaimed, job_locks_reclaimed,
       stale_locks_released, abandoned_files_marked_failed, files_permanently_failed, errors
FROM intake_recovery_runs
WHERE created_at > now() - interval '20 minutes'
ORDER BY created_at DESC
LIMIT 15;
