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
SELECT l.job_id, l.file_id, l.started_at, l.last_progress_at,
       now() - l.started_at AS lock_age, now() - l.last_progress_at AS stale_for
FROM job_intake_locks l
JOIN jobs j ON j.id = l.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY l.started_at DESC;

\echo '=== estimate_runs for this builder''s recent jobs (builder_status is the ESTIMATE_READY signal) ==='
SELECT er.id, er.job_id, er.batch_id, er.status, er.builder_status, er.needs_review_reason,
       er.deadline_at, er.deadline_extensions_used, er.lock_held, er.stall_reason, er.failure_reason,
       er.started_at, er.last_progress_at, er.completed_at, er.reconciled_at
FROM estimate_runs er
JOIN jobs j ON j.id = er.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY er.started_at DESC
LIMIT 3;

\echo '=== estimate_run_events for the most recent run -- the actual state transition history ==='
SELECT ere.from_status, ere.to_status, ere.detail, ere.created_at
FROM estimate_run_events ere
JOIN estimate_runs er ON er.id = ere.estimate_run_id
JOIN jobs j ON j.id = er.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY ere.created_at DESC
LIMIT 30;

\echo '=== Quote + line item count, if a quote already exists ==='
SELECT q.id, q.job_id, q.status, q.total_cost, q.overall_confidence, (q.qa_report IS NOT NULL) AS has_qa_report,
       (SELECT count(*) FROM quote_line_items qli WHERE qli.quote_id = q.id) AS line_item_count,
       (SELECT count(DISTINCT trade_category_id) FROM quote_line_items qli WHERE qli.quote_id = q.id) AS distinct_trades_priced
FROM quotes q
JOIN jobs j ON j.id = q.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY q.created_at DESC
LIMIT 3;

\echo '=== files row for this builder''s recent jobs -- intake_status/failure_stage/failure_reason ==='
SELECT f.id, f.job_id, f.intake_status, f.intake_stage, f.intake_pct, f.failure_stage, f.failure_reason,
       f.quote_id, f.processing_batch_id, f.created_at
FROM files f
JOIN jobs j ON j.id = f.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY f.created_at DESC
LIMIT 3;
