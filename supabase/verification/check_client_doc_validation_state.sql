-- READ-ONLY. Checks the state of the real client-document validation job
-- (7 real documents, 16 Alfred Street Woonona) run via
-- scripts/run-client-documents-estimate.mjs. Zero writes.

\echo '=== most recent client-doc-validation job ==='
SELECT id, address, created_at
FROM jobs
WHERE address LIKE 'CLIENT DOC VALIDATION%'
ORDER BY created_at DESC
LIMIT 3;

\echo '=== its files ==='
SELECT f.id, f.filename, f.intake_status, f.ai_failure_classification, f.ai_failure_count
FROM files f
WHERE f.job_id IN (SELECT id FROM jobs WHERE address LIKE 'CLIENT DOC VALIDATION%' ORDER BY created_at DESC LIMIT 1)
ORDER BY f.filename;

\echo '=== its batch(es) ==='
SELECT b.id, b.status, b.classification_triggered, b.created_at, b.updated_at,
       b.scope_reasoning_completed_at, b.stall_stage, b.stall_reason, b.stalled_at, b.stall_count,
       b.total_ai_call_attempts, b.quote_id
FROM document_processing_batches b
WHERE b.job_id IN (SELECT id FROM jobs WHERE address LIKE 'CLIENT DOC VALIDATION%' ORDER BY created_at DESC LIMIT 1)
ORDER BY b.created_at DESC;

\echo '=== document_processing_jobs (per-document extraction) ==='
SELECT dpj.id, dpj.document_id, dpj.status, dpj.attempts, f.filename
FROM document_processing_jobs dpj
JOIN files f ON f.id = dpj.document_id
WHERE dpj.parent_job_id IN (
  SELECT b.id FROM document_processing_batches b
  WHERE b.job_id IN (SELECT id FROM jobs WHERE address LIKE 'CLIENT DOC VALIDATION%' ORDER BY created_at DESC LIMIT 1)
);

\echo '=== ai_operations for this job ==='
SELECT call_site, status, error_classification, duration_ms, created_at, completed_at
FROM ai_operations
WHERE scope_key LIKE '%' || (SELECT id::text FROM jobs WHERE address LIKE 'CLIENT DOC VALIDATION%' ORDER BY created_at DESC LIMIT 1) || '%'
ORDER BY created_at ASC;

\echo '=== quote, if any ==='
SELECT id, status, total_cost, overall_confidence, qa_report IS NOT NULL AS has_qa, created_at
FROM quotes
WHERE job_id IN (SELECT id FROM jobs WHERE address LIKE 'CLIENT DOC VALIDATION%' ORDER BY created_at DESC LIMIT 1);

\echo '=== job_intake_locks (still active?) ==='
SELECT * FROM job_intake_locks
WHERE job_id IN (SELECT id FROM jobs WHERE address LIKE 'CLIENT DOC VALIDATION%' ORDER BY created_at DESC LIMIT 1);

\echo '=== now ==='
SELECT now();
