-- Read-only: did the recovery cron's new pricing/QA backfill sweep
-- actually price and QA the quote that migration 091 unblocked?

\echo '=== Quote state ==='
SELECT id, status, total_cost, margin_pct, confidence_score, overall_confidence,
       (qa_report IS NOT NULL) AS has_qa_report,
       qa_report -> 'top_risks' AS qa_top_risks,
       price_coverage_pct, pricing_match_rate_pct
FROM quotes WHERE id = '700fc7b2-db92-4373-af21-827030e72f84';

\echo '=== Line items: priced count / total ==='
SELECT count(*) AS total_line_items,
       count(*) FILTER (WHERE total IS NOT NULL) AS priced_line_items,
       round(sum(coalesce(total,0) * (1+coalesce(margin_pct,0)))::numeric,2) AS computed_client_price_ex_gst
FROM quote_line_items WHERE quote_id = '700fc7b2-db92-4373-af21-827030e72f84';

\echo '=== estimate_runs (may still show stale builder_status -- set-once/COALESCE) ==='
SELECT id, status, builder_status, needs_review_reason, completed_at
FROM estimate_runs WHERE batch_id = 'd58c3e92-d16f-425d-ad78-fbc5e8d0c86e';

\echo '=== Recent recovery runs -- did the new backfill sweep log anything? ==='
SELECT id, created_at, stuck_files_retried, errors
FROM intake_recovery_runs
WHERE created_at > now() - interval '10 minutes'
ORDER BY created_at DESC
LIMIT 10;
