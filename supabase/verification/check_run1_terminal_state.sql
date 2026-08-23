-- Read-only: final-state check for job 9f08fde6 / batch f53db004 (the
-- post-slot-claim-fix reliability test), to determine whether Run 1 reached
-- SUCCESS, EXPECTED-STALL-THEN-SUCCESS, or DEADLINE-EXCEEDED/NON-CONVERGENT.

\echo '=== Batch + AI attempt ceiling ==='
SELECT status, classification_triggered, quote_id, stall_stage, stall_count,
       total_ai_call_attempts, updated_at
FROM document_processing_batches WHERE id = 'f53db004-c8a1-471e-aaa9-34abae45ceb0';

\echo '=== estimate_runs: final status/builder_status/deadline ==='
SELECT status, builder_status, needs_review_reason, needs_review_reason_code,
       deadline_extensions_used, deadline_at, now() > deadline_at AS deadline_passed, completed_at
FROM estimate_runs WHERE batch_id = 'f53db004-c8a1-471e-aaa9-34abae45ceb0';

\echo '=== estimate_run_events history (full timeline of what happened) ==='
SELECT created_at, from_status, to_status, detail
FROM estimate_run_events
WHERE estimate_run_id = (SELECT id FROM estimate_runs WHERE batch_id = 'f53db004-c8a1-471e-aaa9-34abae45ceb0')
ORDER BY created_at;

\echo '=== Quote final state ==='
SELECT id, status, total_cost, margin_pct, confidence_score, overall_confidence,
       (qa_report IS NOT NULL) AS has_qa_report
FROM quotes WHERE job_id = '9f08fde6-f631-4d30-b955-53c7a41166c1';

\echo '=== Line items: total, priced, distinct trades ==='
SELECT count(*) AS total_line_items,
       count(*) FILTER (WHERE rate IS NOT NULL) AS priced_line_items,
       count(DISTINCT trade_category_id) AS distinct_trades
FROM quote_line_items
WHERE quote_id = (SELECT id FROM quotes WHERE job_id = '9f08fde6-f631-4d30-b955-53c7a41166c1' LIMIT 1);

\echo '=== DUPLICATE CHECK: any trade+description pair appearing more than once ==='
SELECT trade_category_id, description, count(*) AS occurrences
FROM quote_line_items
WHERE quote_id = (SELECT id FROM quotes WHERE job_id = '9f08fde6-f631-4d30-b955-53c7a41166c1' LIMIT 1)
GROUP BY trade_category_id, description
HAVING count(*) > 1;

\echo '=== DUPLICATE CHECK: quote count for this job (must be exactly 1) ==='
SELECT job_id, count(*) AS quote_count, array_agg(id) AS quote_ids, array_agg(status) AS statuses
FROM quotes WHERE job_id = '9f08fde6-f631-4d30-b955-53c7a41166c1'
GROUP BY job_id;

\echo '=== Total AI spend + attempts for this batch (ceiling check) ==='
SELECT count(*) AS total_ai_calls, sum(cost_cents) AS total_cost_cents
FROM ai_operations WHERE scope_key LIKE '9f08fde6-f631-4d30-b955-53c7a41166c1:%';

\echo '=== job_intake_locks (should be empty) ==='
SELECT * FROM job_intake_locks WHERE job_id = '9f08fde6-f631-4d30-b955-53c7a41166c1';

\echo '=== ai_circuit_breaker ==='
SELECT value FROM system_status WHERE key = 'ai_circuit_breaker';

\echo '=== Recent intake_recovery_runs (churn/convergence signal) ==='
SELECT created_at, document_jobs_reclaimed, job_locks_reclaimed, stuck_files_retried,
       abandoned_files_marked_failed, files_permanently_failed, errors
FROM intake_recovery_runs
ORDER BY created_at DESC
LIMIT 10;
