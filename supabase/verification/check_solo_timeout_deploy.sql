-- READ-ONLY. Best-effort deployment verification for the Stage 1/2
-- solo-batch timeout raise (220s -> 280s). Edge function source isn't
-- queryable via SQL (unlike a Postgres function), so this checks the one
-- DB-visible signal available: whether a subsequent stage_document_
-- intelligence call on this job's known-large document (which previously
-- aborted at ~150000-181048ms) now either succeeds, or -- if it times out
-- again -- aborts near the NEW ~280000ms ceiling rather than the old one,
-- confirming which code the running function is actually using. Zero writes.

\echo '=== stage_document_intelligence calls on job 1f12de7f since the deploy (08:14:59 UTC) ==='
SELECT status, error_classification, duration_ms, created_at
FROM ai_operations
WHERE call_site = 'stage_document_intelligence'
  AND scope_key LIKE '%1f12de7f-47b5-442e-9581-1f813796eb70%'
  AND created_at > '2026-09-03 08:14:59+00'
ORDER BY created_at ASC;

\echo '=== current job_intake_locks / batch state for context ==='
SELECT job_id, started_at, last_progress_at FROM job_intake_locks
WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70';

SELECT id, status, stall_stage, stalled_at, stall_count, quote_id
FROM document_processing_batches
WHERE job_id = '1f12de7f-47b5-442e-9581-1f813796eb70'
ORDER BY created_at DESC LIMIT 1;

\echo '=== now ==='
SELECT now();
