-- READ-ONLY. Checks the pricing/QA backfill sweep's own claim state for the
-- E2E test's quote, to see whether the sweep has attempted it yet and why
-- it may not have succeeded (attempt cap, stale claim, or genuinely not
-- eligible). Zero writes.

\echo '=== quote pricing/QA backfill claim state ==='
SELECT id, job_id, status, total_cost, qa_report IS NOT NULL AS has_qa,
       pricing_qa_backfill_attempts, pricing_qa_backfill_claimed_at, created_at
FROM quotes
WHERE id = '4296b5b6-e339-40a6-b098-ba2876273ec5';

\echo '=== eligibility recheck (does it match the sweep query right now?) ==='
SELECT b.id AS batch_id, b.quote_id, b.status, b.classification_triggered,
       q.total_cost IS NULL OR q.qa_report IS NULL AS still_needs_backfill,
       q.created_at < now() - interval '3 minutes' AS past_age_floor,
       NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = b.job_id) AS no_active_lock
FROM document_processing_batches b
JOIN quotes q ON q.id = b.quote_id
WHERE b.id = '82696199-7590-4069-8d5d-0c64c6940fcc';

\echo '=== quote_line_items for this quote, unpriced count ==='
SELECT count(*) AS total, count(*) FILTER (WHERE rate IS NULL) AS unpriced
FROM quote_line_items
WHERE quote_id = '4296b5b6-e339-40a6-b098-ba2876273ec5';
