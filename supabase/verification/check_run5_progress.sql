-- Run 5 progress check (read-only). Finds the most recent job for the test
-- builder created since the Run 5 trigger time (~04:56 UTC) and reports its
-- full pipeline state.

\echo '=== Most recent job(s) for the test builder since Run 5 started ==='
SELECT id AS job_id, address, status, created_at
FROM jobs
WHERE builder_id = '00000000-0000-0000-0000-0000000000fd'
  AND created_at >= '2026-08-24 04:56:00+00'
ORDER BY created_at DESC;

\echo '=== Batch state for the most recent such job ==='
SELECT b.id AS batch_id, b.job_id, b.status, b.stall_stage, b.stall_reason, b.stall_count,
       b.total_ai_call_attempts, b.classification_triggered, b.quote_id,
       b.scope_reasoning_completed_at, b.stage6_active_calls,
       b.stage3_failure_count, b.stage3_failure_classification,
       b.stage6_failure_count, b.stage6_failure_classification,
       b.created_at, b.updated_at
FROM document_processing_batches b
JOIN jobs j ON j.id = b.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
  AND j.created_at >= '2026-08-24 04:56:00+00'
ORDER BY b.created_at DESC;

\echo '=== document_processing_jobs (per-document extraction) for this batch ==='
SELECT dj.id, dj.status, dj.attempts, dj.document_id, dj.locked_by, dj.locked_at, dj.updated_at
FROM document_processing_jobs dj
WHERE dj.parent_job_id IN (
  SELECT b.id FROM document_processing_batches b
  JOIN jobs j ON j.id = b.job_id
  WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd' AND j.created_at >= '2026-08-24 04:56:00+00'
)
ORDER BY dj.updated_at DESC;

\echo '=== estimate_runs for this job ==='
SELECT er.id, er.status, er.builder_status, er.needs_review_reason, er.deadline_at, er.deadline_extensions_used,
       er.watchdog_consecutive_misses, er.watchdog_total_misses, er.watchdog_escalated_at, er.completed_at
FROM estimate_runs er
JOIN jobs j ON j.id = er.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd' AND j.created_at >= '2026-08-24 04:56:00+00';

\echo '=== job_intake_locks currently held for this job ==='
SELECT l.* FROM job_intake_locks l
JOIN jobs j ON j.id = l.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd' AND j.created_at >= '2026-08-24 04:56:00+00';

\echo '=== AI spend since Run 5 baseline (4382 ops / 3166.26 cost_cents) ==='
SELECT count(*) AS ops_now, sum(cost_cents) AS cost_cents_now, max(created_at) AS last_op_at
FROM ai_operations;

SELECT count(*) AS ops_for_this_run
FROM ai_operations
WHERE created_at >= '2026-08-24 04:56:00+00';

\echo '=== Circuit breaker state ==='
SELECT value FROM system_status WHERE key = 'ai_circuit_breaker';

\echo '=== Recent recovery-cron ticks ==='
SELECT created_at, duration_ms, deadlines_enforced, watchdog_escalations, errors
FROM intake_recovery_runs
WHERE created_at >= '2026-08-24 04:56:00+00'
ORDER BY created_at DESC;

\echo '=== Quote (if created) ==='
SELECT q.id, q.status, q.total_cost, q.overall_confidence, (q.qa_report IS NOT NULL) AS has_qa
FROM quotes q
JOIN jobs j ON j.id = q.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd' AND j.created_at >= '2026-08-24 04:56:00+00';
