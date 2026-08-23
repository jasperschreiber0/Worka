-- Read-only: final decisive state check. The compute_builder_status()
-- dry-run just revealed files.failure_reason is populated with
-- find_and_fail_abandoned_files' message, contradicting an earlier check
-- that only looked at failure_stage (blank) and missed failure_reason
-- entirely. Need the exact current truth, right now, in one read.

\echo '=== files row: EVERY status/failure column, right now ==='
SELECT id, intake_status, failure_stage, failure_reason,
       ai_failure_classification, ai_failure_count, intake_recovery_attempts,
       updated_at
FROM files
WHERE id = 'b27aafa4-6ccd-41f3-a434-73fb7f08174a';

\echo '=== estimate_runs row: has it changed at all since the last read? ==='
SELECT id, status, builder_status, needs_review_reason, needs_review_reason_code,
       deadline_extensions_used, deadline_at, completed_at, reconciled_at
FROM estimate_runs
WHERE id = '826ffcee-d1b7-45bf-8431-5630ba85d358';

\echo '=== intake_recovery_runs: most recent 5 ticks, abandoned_files_marked_failed column specifically ==='
SELECT created_at, abandoned_files_marked_failed, document_jobs_reclaimed, errors
FROM intake_recovery_runs
ORDER BY created_at DESC
LIMIT 5;

\echo '=== job_intake_locks for this job right now (still empty?) ==='
SELECT * FROM job_intake_locks WHERE job_id = '89b77f76-7cb3-427d-ae81-919ea2320c35';

\echo '=== Does find_and_fail_abandoned_files, called dry (as a real call would), currently match this file? Read-only: just check its live definition''s WHERE-equivalent logic against current data ==='
SELECT pg_get_functiondef('find_and_fail_abandoned_files'::regproc);
