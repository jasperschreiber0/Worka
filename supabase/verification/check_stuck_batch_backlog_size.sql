-- READ-ONLY. Every tick from 09:21-09:28 genuinely executed the route (real
-- durations, real RPC calls per net._http_response) and found
-- stuck_files_retried=0, even though batch 9f14b072 was clock-eligible from
-- 09:22:32 onward and a direct SQL call at 09:27:13 found it alone
-- (count=1). Backlog membership isn't static across ticks -- this session's
-- own extensive testing may have left many OTHER eligible batches that
-- were draining through the ordered (migration 104) list ahead of ours at
-- earlier ticks, only clearing by ~09:29. Checks the full current backlog
-- (ids + updated_at, ordered) and MAX_STUCK_FILES_PER_RUN's cap context.
-- Zero writes.

\echo '=== full current backlog, oldest first (as the route sees it) ==='
SELECT batch_id, job_id, primary_file_id
FROM find_stuck_batches_needing_classification_retry();

\echo '=== joined with updated_at/status for age context, oldest first ==='
SELECT b.id AS batch_id, b.job_id, b.updated_at, b.status, b.builder_id,
       EXTRACT(EPOCH FROM (now() - b.updated_at))/60 AS minutes_stale
FROM document_processing_batches b
WHERE b.id IN (SELECT batch_id FROM find_stuck_batches_needing_classification_retry())
ORDER BY b.updated_at ASC;

\echo '=== total backlog count right now ==='
SELECT count(*) FROM find_stuck_batches_needing_classification_retry();

\echo '=== stuck_files_retried sum over the last 60 minutes (how much backlog has been draining) ==='
SELECT count(*) AS ticks, sum(stuck_files_retried) AS total_retried, sum(files_permanently_failed) AS total_capped
FROM intake_recovery_runs
WHERE run_started_at > now() - interval '60 minutes';

\echo '=== per-tick stuck_files_retried for the last 30 minutes, in order ==='
SELECT run_started_at, stuck_files_retried, files_permanently_failed
FROM intake_recovery_runs
WHERE run_started_at > now() - interval '30 minutes'
ORDER BY run_started_at ASC;

\echo '=== now ==='
SELECT now();
