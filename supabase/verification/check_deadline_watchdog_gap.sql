-- Read-only: Run 3's estimate_runs row (826ffcee-d1b7-45bf-8431-5630ba85d358,
-- batch bdeca4fa-4f36-4e95-b87a-4fb063724fde) still shows builder_status
-- NULL / status 'reasoning' with deadline_at 9+ hours in the past. Since
-- stage3_failure_count=1 it should NOT qualify for extension (migration 089
-- requires stage3_failure_count=0) -- it should have been finalized on the
-- very next recovery-cron tick. Did enforce_estimate_deadlines ever run
-- since the deadline passed, and did it error?

\echo '=== intake_recovery_runs since the deadline passed (12:09 UTC) -- deadlines_enforced + errors ==='
SELECT created_at, document_jobs_reclaimed, job_locks_reclaimed, stuck_files_retried,
       abandoned_files_marked_failed, files_permanently_failed, errors
FROM intake_recovery_runs
WHERE created_at > '2026-08-23 12:09:00+00'
ORDER BY created_at
LIMIT 30;

\echo '=== Total intake_recovery_runs rows since deadline (count -- is the cron even still ticking?) ==='
SELECT count(*) AS runs_since_deadline, max(created_at) AS most_recent_run
FROM intake_recovery_runs
WHERE created_at > '2026-08-23 12:09:00+00';

\echo '=== Does route.ts actually call enforce_estimate_deadlines unconditionally? (grep-equivalent: does ANY intake_recovery_runs row have a non-null deadlines-related column at all, ever, for ANY job) ==='
SELECT count(*) FILTER (WHERE errors IS NOT NULL AND errors != '[]'::jsonb) AS runs_with_errors
FROM intake_recovery_runs
WHERE created_at > '2026-08-23 12:09:00+00';

\echo '=== Direct call: what does enforce_estimate_deadlines() return RIGHT NOW for this row? (read-only in the sense that it only finalizes truly-expired rows if any -- but this actually WOULD mutate; instead just check pg_cron run history for errors) ==='
SELECT jrd.runid, jrd.status, jrd.return_message, jrd.start_time, jrd.end_time
FROM cron.job_run_details jrd
JOIN cron.job j ON j.jobid = jrd.jobid
WHERE j.jobname = 'worka-intake-recovery'
  AND jrd.start_time > '2026-08-23 12:09:00+00'
ORDER BY jrd.start_time
LIMIT 30;

\echo '=== estimate_runs row raw, re-confirm ==='
SELECT id, job_id, batch_id, status, builder_status, deadline_extensions_used, deadline_at, now() - deadline_at AS overdue_by
FROM estimate_runs
WHERE id = '826ffcee-d1b7-45bf-8431-5630ba85d358';

\echo '=== Re-check batch predicate fields fresh (has anything changed since the earlier check?) ==='
SELECT id, status, classification_triggered, quote_id, stage3_failure_count, stage6_failure_count, updated_at
FROM document_processing_batches
WHERE id = 'bdeca4fa-4f36-4e95-b87a-4fb063724fde';
