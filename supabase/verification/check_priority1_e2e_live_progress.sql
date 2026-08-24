-- Read-only live-progress check for the Priority 1 (immediate self-retrigger)
-- controlled end-to-end verification. Hardcoded to the specific test job
-- created by this run (JOB-2026-015) so results can never accidentally
-- pick up an older leftover quote/batch from the same reserved test
-- builder (00000000-0000-0000-0000-0000000000fd), which the previous,
-- builder-scoped-only version of this script did.

\set target_job_id 'f2a6fc33-ae23-4852-8126-42743c5c7013'

\echo '=== Target job ==='
SELECT id AS job_id, job_ref, created_at, status FROM jobs WHERE id = :'target_job_id';

\echo '=== document_processing_batches row for this exact job ==='
SELECT b.id AS batch_id, b.status, b.classification_triggered,
       b.scope_reasoning_completed_at, b.stage3_completed_trade_ids,
       array_length(b.stage3_completed_trade_ids, 1) AS stage3_trades_done,
       b.stage6_completed_trade_ids,
       array_length(b.stage6_completed_trade_ids, 1) AS stage6_trades_done,
       b.stall_stage, b.stall_reason, b.stall_count, b.stalled_at,
       b.total_ai_call_attempts, b.quote_id,
       b.created_at, b.updated_at
FROM document_processing_batches b
WHERE b.job_id = :'target_job_id'
ORDER BY b.created_at DESC
LIMIT 1;

\echo '=== job_intake_locks currently held for this job (should be none once handed off) ==='
SELECT * FROM job_intake_locks WHERE job_id = :'target_job_id';

\echo '=== estimate_runs row for this exact job (via its batch) ==='
SELECT er.id, er.batch_id, er.builder_status, er.needs_review_reason,
       er.started_at, er.deadline_at, er.completed_at,
       er.watchdog_consecutive_misses, er.watchdog_total_misses
FROM estimate_runs er
JOIN document_processing_batches b ON b.id = er.batch_id
WHERE b.job_id = :'target_job_id'
ORDER BY er.started_at DESC
LIMIT 1;

\echo '=== Quote for THIS exact job (pricing/QA) ==='
SELECT q.id AS quote_id, q.status, q.total_cost, q.confidence_score,
       (q.qa_report IS NOT NULL) AS has_qa_report, q.created_at
FROM quotes q
WHERE q.job_id = :'target_job_id'
ORDER BY q.created_at DESC
LIMIT 1;

\echo '=== quote_line_items for this job -- count, distinct trades, earliest/latest created_at (proxy for Stage 6 start/finish) ==='
SELECT count(*) AS line_item_count, count(DISTINCT trade_category_id) AS distinct_trades,
       min(created_at) AS first_line_item_at, max(created_at) AS last_line_item_at
FROM quote_line_items
WHERE quote_id = (SELECT id FROM quotes WHERE job_id = :'target_job_id' ORDER BY created_at DESC LIMIT 1);

\echo '=== Any duplicate (quote_id, trade_category_id, description) -- must be zero rows ==='
SELECT quote_id, trade_category_id, description, count(*)
FROM quote_line_items
WHERE quote_id = (SELECT id FROM quotes WHERE job_id = :'target_job_id' ORDER BY created_at DESC LIMIT 1)
GROUP BY quote_id, trade_category_id, description
HAVING count(*) > 1;

\echo '=== ai_operations for this job (scope_key LIKE job_id:%) -- call sites, count, timestamps ==='
SELECT call_site, status, created_at, completed_at, duration_ms
FROM ai_operations
WHERE scope_key LIKE :'target_job_id' || ':%'
ORDER BY created_at;

\echo '=== ai_operations count/cost summary for this job ==='
SELECT count(*) AS ops_count, sum(cost_cents) AS cost_cents
FROM ai_operations
WHERE scope_key LIKE :'target_job_id' || ':%';

\echo '=== document_processing_batches.total_ai_call_attempts (20-call ceiling check) ==='
SELECT total_ai_call_attempts FROM document_processing_batches WHERE job_id = :'target_job_id';

\echo '=== system_status ai_circuit_breaker current value ==='
SELECT key, value FROM system_status WHERE key = 'ai_circuit_breaker';

\echo '=== intake_recovery_runs since this job was created -- did the cron intervene for this batch? ==='
SELECT created_at, deadlines_enforced, document_jobs_reclaimed, job_locks_reclaimed,
       stuck_files_retried, watchdog_escalations, errors
FROM intake_recovery_runs
WHERE created_at >= (SELECT created_at FROM jobs WHERE id = :'target_job_id')
ORDER BY created_at;

\echo '=== now() for reference ==='
SELECT now();
