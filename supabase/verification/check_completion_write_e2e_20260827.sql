-- Read-only production E2E verification for the smooth-responder final
-- completion-write persistence-truthfulness fix (Round 3 audit finding).
-- Job b8cc4472-00b2-4fb4-8c5c-6960d0a51b38 / batch 4d79e5a7-ec5a-4331-95e8-406a5b046e7c
-- was created by scripts/run-known-good-estimate.mjs and left in place
-- ("cleanup_skipped_for_forensics") because the script's own 10-minute
-- ceiling elapsed before Stage 6 fully finished (unrelated to this fix --
-- normal chunked-completion behavior, confirmed separately). The pipeline
-- has since converged on its own via the recovery cron. This checks the
-- exact invariant the fix targets, plus a duplicate check the automated
-- scripts above didn't directly run.

\echo '--- files row for the primary document ---'
SELECT id, intake_status, quote_id, processing_batch_id
FROM files
WHERE id = 'c4a4d405-0745-4821-b4d8-fefd39ba21c2';

\echo '--- document_processing_batches row ---'
SELECT id, status, quote_id, classification_triggered
FROM document_processing_batches
WHERE id = '4d79e5a7-ec5a-4331-95e8-406a5b046e7c';

\echo '--- quotes for this job (must be exactly 1) ---'
SELECT id, status, job_id
FROM quotes
WHERE job_id = 'b8cc4472-00b2-4fb4-8c5c-6960d0a51b38';

\echo '--- quote_line_items count + duplicate (trade_category_id, description) pairs ---'
SELECT count(*) AS total_line_items
FROM quote_line_items
WHERE quote_id = 'c883d6f8-802a-4aea-956c-0352a5024330';

SELECT trade_category_id, description, count(*)
FROM quote_line_items
WHERE quote_id = 'c883d6f8-802a-4aea-956c-0352a5024330'
GROUP BY trade_category_id, description
HAVING count(*) > 1;

\echo '--- the exact invariant this fix targets: must return 0 rows ---'
SELECT f.id, f.intake_status, f.quote_id, b.quote_id AS batch_quote_id
FROM files f
JOIN document_processing_batches b ON b.id = f.processing_batch_id
WHERE f.intake_status = 'extracted' AND f.quote_id IS NULL AND b.quote_id IS NOT NULL
  AND f.job_id = 'b8cc4472-00b2-4fb4-8c5c-6960d0a51b38';
