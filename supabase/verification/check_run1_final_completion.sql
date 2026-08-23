-- Read-only: final completion check for post-fix Run 1's quote.

\echo '=== Quote row ==='
SELECT id, status, total_cost, margin_pct, confidence_score, overall_confidence,
       (qa_report IS NOT NULL) AS has_qa_report
FROM quotes WHERE id = 'e3b5f93f-85d3-4f5e-b51e-0001ceab4123';

\echo '=== Line item count + priced count + distinct trades ==='
SELECT count(*) AS total_line_items,
       count(*) FILTER (WHERE total IS NOT NULL) AS priced_line_items,
       count(DISTINCT trade_category_id) AS distinct_trades
FROM quote_line_items WHERE quote_id = 'e3b5f93f-85d3-4f5e-b51e-0001ceab4123';

\echo '=== Duplicate line items (trade+description appearing more than once) ==='
SELECT trade_category_id, description, count(*) AS occurrences
FROM quote_line_items
WHERE quote_id = 'e3b5f93f-85d3-4f5e-b51e-0001ceab4123'
GROUP BY trade_category_id, description
HAVING count(*) > 1;

\echo '=== Duplicate quote check for this job ==='
SELECT job_id, count(*) AS quote_count, array_agg(id) AS quote_ids
FROM quotes WHERE job_id = '71d94af9-d09d-4954-9601-28f1bb656558'
GROUP BY job_id;

\echo '=== estimate_run current builder_status ==='
SELECT status, builder_status, needs_review_reason_code, completed_at
FROM estimate_runs WHERE job_id = '71d94af9-d09d-4954-9601-28f1bb656558';

\echo '=== batch total_ai_call_attempts breakdown by call_site ==='
SELECT call_site, count(*) AS calls, sum(cost_cents) AS total_cost_cents
FROM ai_operations
WHERE scope_key LIKE '71d94af9-d09d-4954-9601-28f1bb656558:%'
GROUP BY call_site;
