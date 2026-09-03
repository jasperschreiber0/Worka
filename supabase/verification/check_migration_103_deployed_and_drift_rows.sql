-- ONE-TIME, READ-ONLY: confirms the LIVE deployed enforce_estimate_deadlines()
-- definition contains migration 103's extraction_status exemption, and
-- checks whether the two known drift-signature rows now satisfy the
-- corrected extension-eligibility predicate. Zero writes -- does NOT call
-- enforce_estimate_deadlines() itself and does NOT reset either row.

\echo '--- deployed function definition ---'
SELECT pg_get_functiondef('enforce_estimate_deadlines'::regproc);

\echo '--- the two known drift rows, current state ---'
SELECT id AS estimate_run_id, batch_id, job_id, status, builder_status,
       deadline_extensions_used, started_at, completed_at
FROM estimate_runs
WHERE id IN ('8160d6fc-0cc0-4481-8848-748849388664', 'bfb13e91-65f4-4dc7-80ea-cccba6e6cc1e');

\echo '--- would each row now satisfy the CORRECTED extension-eligibility predicate, evaluated as of NOW (read-only, no mutation) ---'
SELECT b.id AS batch_id,
       (b.quote_id IS NULL) AS quote_id_is_null,
       b.status IN ('completed', 'completed_with_failures', 'failed') AS status_terminal,
       b.classification_triggered AS classification_triggered,
       b.stage3_failure_count = 0 AS stage3_ok,
       b.stage6_failure_count = 0 AS stage6_ok,
       NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = b.job_id) AS no_lock,
       NOT EXISTS (
         SELECT 1 FROM document_processing_jobs j
         JOIN files f ON f.id = j.document_id
         WHERE j.parent_job_id = b.id
           AND f.ai_failure_count > 0
           AND NOT EXISTS (SELECT 1 FROM project_documents pd WHERE pd.file_id = f.id AND pd.extraction_status = 'complete')
       ) AS no_unresolved_failure
FROM document_processing_batches b
WHERE b.id IN ('ac0380e4-b74b-46f0-ab9e-e42de35e71c8', '4d131901-06e0-4f97-8eef-240594cc7c38');

\echo '--- control group: the 5 genuinely-unresolved-failure rows must NOT satisfy the extension predicate (still correctly protected) ---'
SELECT er.id AS estimate_run_id, b.id AS batch_id,
       NOT EXISTS (
         SELECT 1 FROM document_processing_jobs j
         JOIN files f ON f.id = j.document_id
         WHERE j.parent_job_id = b.id
           AND f.ai_failure_count > 0
           AND NOT EXISTS (SELECT 1 FROM project_documents pd WHERE pd.file_id = f.id AND pd.extraction_status = 'complete')
       ) AS no_unresolved_failure
FROM estimate_runs er
JOIN document_processing_batches b ON b.id = er.batch_id
WHERE er.id IN (
  '16a14149-eef5-46b2-b8ac-81cfb4e3bca6', '03eed6ab-8416-41d2-a309-a6e23dfe521f',
  '3c5cd239-d352-4a7b-9ea0-e31feb97e413', '65e4cc73-67d2-4ee9-b50f-8cfc6e17c895',
  'e44e57c6-f152-4e23-a53b-d9dd75f5855f'
);
