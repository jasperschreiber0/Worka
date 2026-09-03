-- READ-ONLY. Final-state confirmation for the controlled E2E production
-- test: does the quote now have real pricing + QA, and did the
-- estimate_run finalize to a builder_status? Zero writes.

\echo '=== quote final state ==='
SELECT id, job_id, status, total_cost, overall_confidence,
       qa_report IS NOT NULL AS has_qa, created_at
FROM quotes
WHERE id = '4296b5b6-e339-40a6-b098-ba2876273ec5';

\echo '=== line items: total vs unpriced ==='
SELECT count(*) AS total, count(*) FILTER (WHERE rate IS NULL) AS unpriced,
       sum(total) AS sum_total
FROM quote_line_items
WHERE quote_id = '4296b5b6-e339-40a6-b098-ba2876273ec5';

\echo '=== estimate_run final state ==='
SELECT id, status, builder_status, needs_review_reason, deadline_extensions_used,
       coverage_percentage, confidence_level, started_at, completed_at, reconciled_at
FROM estimate_runs
WHERE job_id = '1eec138a-09d7-42fa-afdc-6e653b01a333';

\echo '=== job final state ==='
SELECT id, status, knowledge_confidence, knowledge_missing_count
FROM jobs WHERE id = '1eec138a-09d7-42fa-afdc-6e653b01a333';
