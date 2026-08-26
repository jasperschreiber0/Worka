-- Final verification: Batch A resolved live during this investigation
-- (quote 9dcd50cc-f436-43f1-afbc-d0ca7bd5fb65 created, estimate_run
-- finalized ESTIMATE_READY at 21:05:16). This checks for duplicate
-- quotes/line items on the job, and re-confirms Batch B's final state
-- for the report's before/after comparison. Entirely read-only.

\echo '=== 1. All quotes for Batch A job -- exactly one expected ==='
SELECT id, job_id, status, version, total_cost, created_at
FROM quotes WHERE job_id = '2b22dcb5-6862-40e2-abbc-764263bf17d6'
ORDER BY created_at;

\echo '=== 2. Line item count + trade coverage for the new quote ==='
SELECT trade_category_id, count(*) AS line_item_count
FROM quote_line_items WHERE quote_id = '9dcd50cc-f436-43f1-afbc-d0ca7bd5fb65'
GROUP BY trade_category_id ORDER BY trade_category_id;

\echo '=== 3. Any duplicate (trade_category_id, description) pairs on this quote? ==='
SELECT trade_category_id, description, count(*)
FROM quote_line_items WHERE quote_id = '9dcd50cc-f436-43f1-afbc-d0ca7bd5fb65'
GROUP BY trade_category_id, description HAVING count(*) > 1;

\echo '=== 4. job_intake_locks -- clean (none held) for Batch A job? ==='
SELECT * FROM job_intake_locks WHERE job_id = '2b22dcb5-6862-40e2-abbc-764263bf17d6';

\echo '=== 5. Batch B current state (re-confirm, for before/after comparison) ==='
SELECT b.id, b.status, b.stall_stage, b.quote_id, b.stage6_completed_trade_ids, b.updated_at
FROM document_processing_batches b WHERE b.id = 'd4701fc1-f4be-4f75-9eb4-cf031f66cb33';

\echo '=== 6. Batch B quotes -- exactly one expected, and its pricing/QA state ==='
SELECT id, status, total_cost, qa_report IS NOT NULL AS has_qa_report, overall_confidence, created_at
FROM quotes WHERE job_id = '231f2747-38a8-44d0-a8c5-ef883a2830ab'
ORDER BY created_at;

\echo '=== 7. Batch B job_intake_locks -- clean? ==='
SELECT * FROM job_intake_locks WHERE job_id = '231f2747-38a8-44d0-a8c5-ef883a2830ab';
