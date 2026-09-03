-- READ-ONLY. Focused investigation: is the Stage 1/2 (stage_document_intelligence)
-- Claude call timeout too aggressive for real construction documents?
-- Zero writes. No code touched by this file.

\echo '=== 1. stage_document_intelligence: global outcome breakdown, last 14 days ==='
SELECT status, error_classification, count(*) AS n,
       round(avg(duration_ms)) AS avg_duration_ms,
       min(duration_ms) AS min_duration_ms,
       max(duration_ms) AS max_duration_ms,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS median_duration_ms,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) AS p90_duration_ms
FROM ai_operations
WHERE call_site = 'stage_document_intelligence'
  AND created_at > now() - interval '14 days'
GROUP BY status, error_classification
ORDER BY n DESC;

\echo '=== 2. Successful calls only: full duration distribution (are they clustered near the 150s/220s/280s ceilings, or well under?) ==='
SELECT
  count(*) FILTER (WHERE duration_ms < 60000) AS under_60s,
  count(*) FILTER (WHERE duration_ms >= 60000 AND duration_ms < 100000) AS s60_100,
  count(*) FILTER (WHERE duration_ms >= 100000 AND duration_ms < 140000) AS s100_140,
  count(*) FILTER (WHERE duration_ms >= 140000 AND duration_ms < 150000) AS s140_150,
  count(*) FILTER (WHERE duration_ms >= 150000 AND duration_ms < 200000) AS s150_200,
  count(*) FILTER (WHERE duration_ms >= 200000 AND duration_ms < 220000) AS s200_220,
  count(*) FILTER (WHERE duration_ms >= 220000) AS s220_plus
FROM ai_operations
WHERE call_site = 'stage_document_intelligence' AND status = 'succeeded'
  AND created_at > now() - interval '14 days';

\echo '=== 3. Failed (application_timeout) calls: exact duration at abort, last 14 days ==='
SELECT duration_ms, created_at, scope_key
FROM ai_operations
WHERE call_site = 'stage_document_intelligence'
  AND error_classification = 'application_timeout'
  AND created_at > now() - interval '14 days'
ORDER BY created_at DESC
LIMIT 30;

\echo '=== 4. Timeout frequency: failed vs total, per day, last 14 days ==='
SELECT date_trunc('day', created_at) AS day,
       count(*) FILTER (WHERE status = 'succeeded') AS succeeded,
       count(*) FILTER (WHERE error_classification = 'application_timeout') AS timed_out,
       count(*) FILTER (WHERE status = 'failed' AND error_classification != 'application_timeout') AS other_failed,
       count(*) AS total
FROM ai_operations
WHERE call_site = 'stage_document_intelligence'
  AND created_at > now() - interval '14 days'
GROUP BY 1
ORDER BY 1 DESC;

\echo '=== 5. This specific job (1f12de7f) full stage_document_intelligence history with scope_key ==='
SELECT status, error_classification, duration_ms, created_at, scope_key, attempt
FROM ai_operations
WHERE call_site = 'stage_document_intelligence'
  AND scope_key LIKE '%1f12de7f-47b5-442e-9581-1f813796eb70%'
ORDER BY created_at ASC;

\echo '=== 6. Retries typically required: how many attempts before a scope_key succeeds (global, last 14 days, only scope_keys that eventually succeeded) ==='
SELECT attempts_before_success, count(*) AS n
FROM (
  SELECT scope_key, count(*) FILTER (WHERE status != 'succeeded' AND created_at < (
    SELECT min(created_at) FROM ai_operations a2
    WHERE a2.scope_key = a1.scope_key AND a2.call_site = 'stage_document_intelligence' AND a2.status = 'succeeded'
  )) AS attempts_before_success
  FROM ai_operations a1
  WHERE call_site = 'stage_document_intelligence'
    AND created_at > now() - interval '14 days'
    AND scope_key IS NOT NULL
    AND EXISTS (SELECT 1 FROM ai_operations a3 WHERE a3.scope_key = a1.scope_key AND a3.call_site = 'stage_document_intelligence' AND a3.status = 'succeeded')
  GROUP BY scope_key
) sub
GROUP BY attempts_before_success
ORDER BY attempts_before_success;

\echo '=== 7. Document characteristics for THIS jobs stuck files: size/page count from document_processing_jobs.result ==='
SELECT f.id, f.original_filename, f.file_size_bytes,
       j.result->>'pageCount' AS page_count,
       j.result->>'blockType' AS block_type,
       j.result->>'durationMs' AS extraction_duration_ms,
       j.status AS extraction_job_status
FROM files f
LEFT JOIN document_processing_jobs j ON j.document_id = f.id
WHERE f.job_id = '1f12de7f-47b5-442e-9581-1f813796eb70'
ORDER BY (f.file_size_bytes) DESC NULLS LAST
LIMIT 20;

\echo '=== 8. Cross-job: does duration correlate with file_size_bytes? (join via document_processing_jobs -> parent batch -> files, last 14 days, successful stage_document_intelligence calls approximated via batch-level scope_key) ==='
SELECT f.file_size_bytes, j.result->>'pageCount' AS page_count, j.result->>'durationMs' AS extraction_duration_ms
FROM document_processing_jobs j
JOIN files f ON f.id = j.document_id
WHERE j.updated_at > now() - interval '14 days'
  AND j.status = 'completed'
ORDER BY f.file_size_bytes DESC NULLS LAST
LIMIT 30;

\echo '=== 9. What happens after a timeout -- retry_or_fail_document_job / classification retry cadence: recent intake_recovery_runs stuck_files_retried totals, 14 days ==='
SELECT count(*) AS runs, sum(stuck_files_retried) AS total_stuck_files_retried,
       sum(document_jobs_reclaimed) AS total_document_jobs_reclaimed
FROM intake_recovery_runs
WHERE run_started_at > now() - interval '14 days';

\echo '=== 10. Batches that stalled specifically at classifying_documents (not reasoning_scope) -- direct evidence Stage1/2 alone exhausts the wall-clock budget ==='
SELECT count(*) AS n, stall_stage
FROM document_processing_batches
WHERE created_at > now() - interval '14 days'
  AND stall_stage IS NOT NULL
GROUP BY stall_stage
ORDER BY n DESC;
