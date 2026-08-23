-- Read-only: is the pricing/QA backfill sweep's LIMIT 10 being starved by
-- stale unpriced quotes left over from earlier test/debug sessions?
\echo '=== Count of ALL quotes eligible for the pricing/QA sweep right now ==='
SELECT count(*) AS total_eligible_candidates
FROM quotes q
JOIN document_processing_batches b ON b.quote_id = q.id
WHERE b.status IN ('completed', 'completed_with_failures', 'failed')
  AND b.classification_triggered = true
  AND (q.total_cost IS NULL OR q.qa_report IS NULL)
  AND q.created_at < now() - interval '3 minutes';

\echo '=== The actual candidate list (default/unordered, matching what the route sees with LIMIT 10) ==='
SELECT q.id AS quote_id, q.job_id, j.address, q.created_at, q.pricing_qa_backfill_attempts,
       (q.total_cost IS NULL) AS needs_pricing, (q.qa_report IS NULL) AS needs_qa
FROM quotes q
JOIN document_processing_batches b ON b.quote_id = q.id
JOIN jobs j ON j.id = q.job_id
WHERE b.status IN ('completed', 'completed_with_failures', 'failed')
  AND b.classification_triggered = true
  AND (q.total_cost IS NULL OR q.qa_report IS NULL)
  AND q.created_at < now() - interval '3 minutes'
LIMIT 15;
