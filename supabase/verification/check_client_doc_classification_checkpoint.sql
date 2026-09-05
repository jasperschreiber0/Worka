-- READ-ONLY. The client-document-validation batch's Stage 1/2 Claude call
-- (stage_document_intelligence) succeeded once (227812ms, all 7 files in
-- one batch) before the invocation wall-clock-bailed at Stage 3
-- (reasoning_scope). On retrigger, THREE MORE stage_document_intelligence
-- calls fired instead of skipping straight to Stage 3 -- meaning
-- index.ts's exclusion filter (checks project_documents.extraction_status
-- = 'complete') did NOT exclude these files. This checks the actual
-- project_documents rows to see whether extraction_status was ever set to
-- 'complete' for them, or whether the persist step never ran before the
-- wall-clock bail. Zero writes.

\echo '=== project_documents rows for this job ==='
SELECT pd.file_id, f.filename, pd.extraction_status, pd.created_at, pd.updated_at
FROM project_documents pd
JOIN files f ON f.id = pd.file_id
WHERE pd.job_id IN (SELECT id FROM jobs WHERE address LIKE 'CLIENT DOC VALIDATION%' ORDER BY created_at DESC LIMIT 1)
ORDER BY f.filename;

\echo '=== project_facts count for this job (were any facts ever persisted?) ==='
SELECT count(*) AS total_facts, count(*) FILTER (WHERE superseded) AS superseded_facts
FROM project_facts
WHERE job_id IN (SELECT id FROM jobs WHERE address LIKE 'CLIENT DOC VALIDATION%' ORDER BY created_at DESC LIMIT 1);

\echo '=== batch row right now (has it converged since the last check?) ==='
SELECT id, status, updated_at, scope_reasoning_completed_at, stall_stage, stalled_at, stall_count, total_ai_call_attempts, quote_id
FROM document_processing_batches
WHERE job_id IN (SELECT id FROM jobs WHERE address LIKE 'CLIENT DOC VALIDATION%' ORDER BY created_at DESC LIMIT 1);

\echo '=== ai_operations, full history, in order ==='
SELECT call_site, status, error_classification, duration_ms, created_at, completed_at
FROM ai_operations
WHERE scope_key LIKE '%' || (SELECT id::text FROM jobs WHERE address LIKE 'CLIENT DOC VALIDATION%' ORDER BY created_at DESC LIMIT 1) || '%'
ORDER BY created_at ASC;

\echo '=== job_intake_locks right now ==='
SELECT * FROM job_intake_locks
WHERE job_id IN (SELECT id FROM jobs WHERE address LIKE 'CLIENT DOC VALIDATION%' ORDER BY created_at DESC LIMIT 1);

\echo '=== ai_spend_daily for the test builder today (real cost check) ==='
SELECT builder_id, day, cost_cents, call_count
FROM ai_spend_daily
WHERE builder_id = '00000000-0000-0000-0000-0000000000fc' AND day = current_date;

\echo '=== now ==='
SELECT now();
