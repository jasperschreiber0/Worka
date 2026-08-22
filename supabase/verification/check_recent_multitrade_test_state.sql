-- Read-only: live state of the most recent multi-trade known-good test
-- batch (builder_id 00000000-0000-0000-0000-0000000000fd), whether it's
-- still running or already finished. Safe to run at any point mid-test.

\echo '=== Recent jobs for this test builder ==='
SELECT id, address, status, created_at
FROM jobs
WHERE builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY created_at DESC
LIMIT 3;

\echo '=== Recent document_processing_batches for this builder ==='
SELECT id, job_id, status, classification_triggered, quote_id,
       stall_stage, stall_reason, stalled_at, stall_count,
       scope_reasoning_completed_at,
       array_length(stage3_completed_trade_ids, 1) AS stage3_trades_done,
       array_length(stage6_completed_trade_ids, 1) AS stage6_trades_done,
       stage3_failure_count, stage6_failure_count,
       total_ai_call_attempts, updated_at, created_at
FROM document_processing_batches
WHERE builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY created_at DESC
LIMIT 3;

\echo '=== job_intake_locks currently held for this builder''s recent jobs ==='
SELECT l.job_id, l.acquired_at, l.last_progress_at, now() - l.last_progress_at AS stale_for
FROM job_intake_locks l
JOIN jobs j ON j.id = l.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY l.acquired_at DESC;

\echo '=== estimate_runs for this builder''s recent jobs ==='
SELECT er.id, er.job_id, er.batch_id, er.status, er.builder_status, er.needs_review_reason,
       er.deadline_at, er.deadline_extensions_used, er.created_at, er.completed_at
FROM estimate_runs er
JOIN jobs j ON j.id = er.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY er.created_at DESC
LIMIT 3;

\echo '=== Quote + line item count, if a quote already exists ==='
SELECT q.id, q.job_id, q.status, q.total_cost, q.overall_confidence, (q.qa_report IS NOT NULL) AS has_qa_report,
       (SELECT count(*) FROM quote_line_items qli WHERE qli.quote_id = q.id) AS line_item_count,
       (SELECT count(DISTINCT trade_category_id) FROM quote_line_items qli WHERE qli.quote_id = q.id) AS distinct_trades_priced
FROM quotes q
JOIN jobs j ON j.id = q.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY q.created_at DESC
LIMIT 3;

\echo '=== intake_recovery_runs since this test started ==='
SELECT id, created_at, duration_ms, document_jobs_reclaimed, job_locks_reclaimed,
       stale_locks_released, abandoned_files_marked_failed, files_permanently_failed, errors
FROM intake_recovery_runs
WHERE created_at > now() - interval '30 minutes'
ORDER BY created_at DESC
LIMIT 30;
