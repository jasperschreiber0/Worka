-- Read-only, reusable across Runs 2-5: full state dump for whichever job is
-- most recent for the reliability-test builder. No hardcoded IDs.

\echo '=== Most recent job ==='
SELECT id, address, status, created_at
FROM jobs
WHERE builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY created_at DESC LIMIT 1;

\echo '=== Batch state (Stage1/2, Stage3, Stage6, AI ceiling) ==='
SELECT b.id, b.status, b.classification_triggered, b.quote_id, b.stall_stage, b.stall_count,
       b.stage3_trades_done, b.stage6_trades_done, b.stage3_failure_count, b.stage6_failure_count,
       b.total_ai_call_attempts, b.stage6_active_calls, b.created_at, b.updated_at
FROM document_processing_batches b
JOIN jobs j ON j.id = b.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY b.created_at DESC LIMIT 1;

\echo '=== estimate_runs + event history ==='
SELECT er.id, er.status, er.builder_status, er.needs_review_reason, er.needs_review_reason_code,
       er.deadline_extensions_used, er.deadline_at, er.completed_at
FROM estimate_runs er
JOIN jobs j ON j.id = er.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY er.created_at DESC LIMIT 1;

SELECT ere.created_at, ere.from_status, ere.to_status, ere.detail
FROM estimate_run_events ere
WHERE ere.estimate_run_id = (
  SELECT er.id FROM estimate_runs er JOIN jobs j ON j.id = er.job_id
  WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
  ORDER BY er.created_at DESC LIMIT 1
)
ORDER BY ere.created_at;

\echo '=== ai_operations timeline (per-stage calls, for concurrency + cost) ==='
SELECT ao.id, ao.call_site, ao.status, ao.created_at, ao.completed_at,
       EXTRACT(EPOCH FROM (COALESCE(ao.completed_at, now()) - ao.created_at)) AS duration_s, ao.cost_cents
FROM ai_operations ao
WHERE ao.scope_key LIKE (
  (SELECT j.id::text FROM jobs j WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY j.created_at DESC LIMIT 1)
  || ':%'
)
ORDER BY ao.created_at;

\echo '=== Max concurrent stage_estimate_generation calls (sweep-line) ==='
WITH s6 AS (
  SELECT created_at AS t, 1 AS delta FROM ai_operations
  WHERE scope_key = (
    (SELECT j.id::text FROM jobs j WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY j.created_at DESC LIMIT 1)
    || ':stage_estimate_generation'
  )
  UNION ALL
  SELECT COALESCE(completed_at, now()) AS t, -1 AS delta FROM ai_operations
  WHERE scope_key = (
    (SELECT j.id::text FROM jobs j WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY j.created_at DESC LIMIT 1)
    || ':stage_estimate_generation'
  )
)
SELECT COALESCE(max(running), 0) AS max_concurrent_stage6_calls
FROM (SELECT sum(delta) OVER (ORDER BY t, delta DESC) AS running FROM s6) x;

\echo '=== Quote + line items + duplicate check ==='
SELECT q.id, q.status, q.total_cost, q.margin_pct, q.confidence_score, q.overall_confidence,
       (q.qa_report IS NOT NULL) AS has_qa_report
FROM quotes q
JOIN jobs j ON j.id = q.job_id
WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
ORDER BY q.created_at DESC LIMIT 1;

SELECT count(*) AS total_line_items, count(*) FILTER (WHERE rate IS NOT NULL) AS priced,
       count(DISTINCT trade_category_id) AS distinct_trades
FROM quote_line_items
WHERE quote_id = (
  SELECT q.id FROM quotes q JOIN jobs j ON j.id = q.job_id
  WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
  ORDER BY q.created_at DESC LIMIT 1
);

SELECT trade_category_id, description, count(*) AS occurrences
FROM quote_line_items
WHERE quote_id = (
  SELECT q.id FROM quotes q JOIN jobs j ON j.id = q.job_id
  WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
  ORDER BY q.created_at DESC LIMIT 1
)
GROUP BY trade_category_id, description HAVING count(*) > 1;

SELECT j.id AS job_id, count(*) AS quote_count, array_agg(q.id) AS quote_ids, array_agg(q.status) AS statuses
FROM quotes q JOIN jobs j ON j.id = q.job_id
WHERE j.id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1)
GROUP BY j.id;

\echo '=== job_intake_locks (should be empty once genuinely done) ==='
SELECT * FROM job_intake_locks
WHERE job_id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1);

\echo '=== ai_circuit_breaker ==='
SELECT value FROM system_status WHERE key = 'ai_circuit_breaker';

\echo '=== intake_recovery_runs last 10 (retry-churn signal) ==='
SELECT created_at, document_jobs_reclaimed, job_locks_reclaimed, stuck_files_retried,
       abandoned_files_marked_failed, files_permanently_failed, errors
FROM intake_recovery_runs ORDER BY created_at DESC LIMIT 10;

\echo '=== File recovery attempt counter ==='
SELECT id, intake_recovery_attempts, intake_status, ai_failure_count, ai_failure_classification, failure_stage
FROM files
WHERE id = (
  SELECT primary_file_id FROM document_processing_batches b JOIN jobs j ON j.id = b.job_id
  WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd'
  ORDER BY b.created_at DESC LIMIT 1
);
