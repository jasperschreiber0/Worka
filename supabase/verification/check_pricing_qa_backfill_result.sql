-- Cleanup: delete the disposable multi-trade test job created this session
-- for diagnosing the Stage 6 wall-clock/recovery-cron incident (address
-- field literally says "safe to delete"). Wrapped in a transaction with a
-- pre/post row count check so a mistake rolls back visibly rather than
-- silently deleting the wrong thing.
--
-- files.job_id / document_processing_batches.primary_file_id cascade in a
-- way that requires files deleted first (document_processing_batches has
-- no cascade FROM files.processing_batch_id, only TO it via primary_file_id
-- -- deleting files cascades the batch via primary_file_id, and
-- document_processing_jobs cascades from both files.id and batches.id).
-- Everything else (quotes, quote_line_items, assumptions, scope_items,
-- project_facts, project_documents, clarifying_questions, estimate_runs,
-- estimate_run_events, job_tasks, job_workers, job_intake_locks) cascades
-- directly from jobs(id) ON DELETE CASCADE.

BEGIN;

\echo '=== Before: row counts for this job ==='
SELECT
  (SELECT count(*) FROM jobs WHERE id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330') AS jobs,
  (SELECT count(*) FROM files WHERE job_id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330') AS files,
  (SELECT count(*) FROM quotes WHERE job_id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330') AS quotes,
  (SELECT count(*) FROM document_processing_batches WHERE job_id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330') AS batches;

-- project_facts.source_document_id -> project_documents(id) has no cascade,
-- and both project_facts and project_documents cascade directly from
-- jobs(id) -- cascading them together via one DELETE FROM jobs hit an FK
-- ordering error live (project_documents deleted before project_facts in
-- the same statement's cascade resolution). Deleting project_facts
-- explicitly first avoids relying on cross-sibling cascade ordering.
DELETE FROM project_facts WHERE job_id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330';
DELETE FROM files WHERE job_id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330';
DELETE FROM jobs WHERE id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330';

\echo '=== After: row counts (all should be 0) ==='
SELECT
  (SELECT count(*) FROM jobs WHERE id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330') AS jobs,
  (SELECT count(*) FROM files WHERE job_id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330') AS files,
  (SELECT count(*) FROM quotes WHERE job_id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330') AS quotes,
  (SELECT count(*) FROM document_processing_batches WHERE job_id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330') AS batches;

COMMIT;
