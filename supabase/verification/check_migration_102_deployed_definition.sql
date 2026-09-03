-- ONE-TIME, READ-ONLY: confirms the LIVE deployed definition of
-- find_stuck_batches_needing_classification_retry actually contains the
-- migration-102 extraction_status exemption, and directly executes the
-- exact same SELECT as a raw SQL statement (bypassing PostgREST entirely)
-- against the real target batch, to determine whether the discrepancy
-- between the hand-simulated JS predicate (says: included) and the live
-- PostgREST RPC call (says: excluded) is a deploy/definition problem or a
-- PostgREST-layer difference.

\echo '--- deployed function definition ---'
SELECT pg_get_functiondef('find_stuck_batches_needing_classification_retry'::regproc);

\echo '--- direct SQL call, no PostgREST involved ---'
SELECT * FROM find_stuck_batches_needing_classification_retry();

\echo '--- target batch raw state ---'
SELECT id, status, classification_triggered, updated_at, stage3_failure_count, stage6_failure_count,
       now() - updated_at AS age
FROM document_processing_batches
WHERE id = 'ac0380e4-b74b-46f0-ab9e-e42de35e71c8';

\echo '--- target batch: job_intake_locks check ---'
SELECT * FROM job_intake_locks WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70';

\echo '--- target batch: estimate_runs check ---'
SELECT * FROM estimate_runs WHERE batch_id = 'ac0380e4-b74b-46f0-ab9e-e42de35e71c8';

\echo '--- target batch: document_processing_jobs + files + project_documents join, raw ---'
SELECT j.document_id, f.ai_failure_count, f.ai_failure_classification,
       pd.id AS project_documents_id, pd.extraction_status
FROM document_processing_jobs j
JOIN files f ON f.id = j.document_id
LEFT JOIN project_documents pd ON pd.file_id = f.id
WHERE j.parent_job_id = 'ac0380e4-b74b-46f0-ab9e-e42de35e71c8';
