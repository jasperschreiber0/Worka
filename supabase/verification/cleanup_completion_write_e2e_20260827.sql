-- Cleanup for the synthetic job created by run-known-good-estimate.mjs during
-- the completion-write persistence-truthfulness fix verification. Left in
-- place ("cleanup_skipped_for_forensics") only because the script's own
-- 10-minute ceiling elapsed before Stage 6 finished within that one script
-- invocation -- the pipeline itself completed correctly afterward via the
-- normal recovery cron, independently verified in
-- check_completion_write_e2e_20260827.sql. Safe to delete now.

DELETE FROM quote_line_items WHERE quote_id = 'c883d6f8-802a-4aea-956c-0352a5024330';
DELETE FROM assumptions WHERE quote_id = 'c883d6f8-802a-4aea-956c-0352a5024330';
DELETE FROM quotes WHERE id = 'c883d6f8-802a-4aea-956c-0352a5024330';
DELETE FROM project_facts WHERE job_id = 'b8cc4472-00b2-4fb4-8c5c-6960d0a51b38';
DELETE FROM scope_items WHERE job_id = 'b8cc4472-00b2-4fb4-8c5c-6960d0a51b38';
DELETE FROM project_documents WHERE job_id = 'b8cc4472-00b2-4fb4-8c5c-6960d0a51b38';
DELETE FROM document_processing_jobs WHERE batch_id = '4d79e5a7-ec5a-4331-95e8-406a5b046e7c';
DELETE FROM document_processing_batches WHERE id = '4d79e5a7-ec5a-4331-95e8-406a5b046e7c';
DELETE FROM estimate_runs WHERE job_id = 'b8cc4472-00b2-4fb4-8c5c-6960d0a51b38';
DELETE FROM files WHERE job_id = 'b8cc4472-00b2-4fb4-8c5c-6960d0a51b38';
DELETE FROM jobs WHERE id = 'b8cc4472-00b2-4fb4-8c5c-6960d0a51b38';

\echo '--- confirm cleanup ---'
SELECT count(*) AS remaining_files FROM files WHERE job_id = 'b8cc4472-00b2-4fb4-8c5c-6960d0a51b38';
SELECT count(*) AS remaining_jobs FROM jobs WHERE id = 'b8cc4472-00b2-4fb4-8c5c-6960d0a51b38';
