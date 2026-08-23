-- Read-only: live state of the currently-running reliability test run 4,
-- for builder 00000000-0000-0000-0000-0000000000fd.

\echo '=== Most recent job ==='
SELECT id, address, status, created_at, now() - created_at AS age
FROM jobs
WHERE builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY created_at DESC
LIMIT 1;

\echo '=== Batch state ==='
SELECT b.id, b.status, b.classification_triggered, b.quote_id,
       b.stall_stage, b.stall_reason, b.stall_count, b.total_ai_call_attempts,
       array_length(b.stage3_completed_trade_ids, 1) AS stage3_trades_done,
       array_length(b.stage6_completed_trade_ids, 1) AS stage6_trades_done,
       b.stage3_failure_count, b.stage3_failure_classification, b.stage6_failure_count,
       b.updated_at, now() - b.updated_at AS since_last_update
FROM document_processing_batches b
JOIN jobs j ON j.id = b.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY b.created_at DESC
LIMIT 1;

\echo '=== job_intake_locks ==='
SELECT l.job_id, l.file_id, l.started_at, l.last_progress_at, now() - l.last_progress_at AS stale_for
FROM job_intake_locks l
JOIN jobs j ON j.id = l.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd';

\echo '=== files ==='
SELECT f.id, f.intake_status, f.intake_stage, f.intake_pct, f.failure_stage, f.failure_reason
FROM files f
WHERE f.job_id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1);
