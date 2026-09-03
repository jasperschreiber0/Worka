-- READ-ONLY. The pricing/QA backfill sweep in GET /api/cron/intake-recovery
-- has run every minute since the E2E quote became eligible, yet
-- pricing_qa_backfill_attempts is still 0 for it. Checks whether the sweep's
-- candidate query (batches with quote_id set, terminal status,
-- classification_triggered=true, joined to quotes needing total_cost/
-- qa_report, past the 3-minute age floor) returns MORE than
-- MAX_PRICING_QA_BACKFILL_PER_RUN (10) rows -- if so, the E2E quote is being
-- crowded out of the bounded sweep every single tick by an older backlog
-- that never clears (e.g. quotes stuck permanently failing pricing/QA,
-- capped at 3 attempts but that cap not actually excluding them from this
-- query, which has no attempts filter at all). Zero writes.

\echo '=== 1. Full candidate count (no LIMIT) matching the sweep predicate ==='
SELECT count(*) AS total_candidates
FROM document_processing_batches b
JOIN quotes q ON q.id = b.quote_id
WHERE b.quote_id IS NOT NULL
  AND b.status IN ('completed', 'completed_with_failures', 'failed')
  AND b.classification_triggered = true
  AND (q.total_cost IS NULL OR q.qa_report IS NULL)
  AND q.created_at < now() - interval '3 minutes';

\echo '=== 2. First 15 candidates in DEFAULT (unordered) query order -- is our quote crowded out? ==='
SELECT q.id AS quote_id, q.job_id, q.created_at, q.pricing_qa_backfill_attempts, q.pricing_qa_backfill_claimed_at
FROM document_processing_batches b
JOIN quotes q ON q.id = b.quote_id
WHERE b.quote_id IS NOT NULL
  AND b.status IN ('completed', 'completed_with_failures', 'failed')
  AND b.classification_triggered = true
  AND (q.total_cost IS NULL OR q.qa_report IS NULL)
  AND q.created_at < now() - interval '3 minutes'
LIMIT 15;

\echo '=== 3. How many candidates are already capped (attempts >= 3) and should have stopped being retried, but this query has NO attempts filter so they still occupy result rows every tick ==='
SELECT count(*) AS capped_but_still_matched
FROM document_processing_batches b
JOIN quotes q ON q.id = b.quote_id
WHERE b.quote_id IS NOT NULL
  AND b.status IN ('completed', 'completed_with_failures', 'failed')
  AND b.classification_triggered = true
  AND (q.total_cost IS NULL OR q.qa_report IS NULL)
  AND q.created_at < now() - interval '3 minutes'
  AND q.pricing_qa_backfill_attempts >= 3;

\echo '=== 4. Our target quote specific attempts/claim state, for cross-reference ==='
SELECT id, pricing_qa_backfill_attempts, pricing_qa_backfill_claimed_at, created_at
FROM quotes WHERE id = '4296b5b6-e339-40a6-b098-ba2876273ec5';
