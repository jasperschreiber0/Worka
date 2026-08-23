-- Read-only: why isn't pricing/QA backfill converging for the latest job's quote?
\echo '=== Quote pricing/QA backfill attempt state ==='
SELECT id, job_id, status, total_cost, (qa_report IS NOT NULL) AS has_qa_report,
       pricing_qa_backfill_attempts, created_at
FROM quotes
WHERE job_id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1);

\echo '=== Batch eligibility for the pricing/QA sweep query, replicated exactly ==='
SELECT b.id, b.quote_id, b.job_id, b.status, b.classification_triggered
FROM document_processing_batches b
WHERE b.quote_id IS NOT NULL
  AND b.status IN ('completed', 'completed_with_failures', 'failed')
  AND b.classification_triggered = true
  AND b.job_id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1);

\echo '=== claim_quote_for_pricing_qa_backfill function signature ==='
SELECT proname, pronargs, prorettype::regtype FROM pg_proc WHERE proname = 'claim_quote_for_pricing_qa_backfill';

\echo '=== Line items rate/pricing_type spot check (why might ensureQuotePriced fail) ==='
SELECT trade_category_id, description, pricing_type, rate, source_ref
FROM quote_line_items
WHERE quote_id = (
  SELECT id FROM quotes
  WHERE job_id = (SELECT id FROM jobs WHERE builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY created_at DESC LIMIT 1)
)
LIMIT 5;
