-- 040_intake_recovery_attempt_cap.sql
-- Hard retry cap for the independent intake recovery cron (see
-- app/api/cron/intake-recovery/route.ts, migration 037). Root cause of an
-- uncontrolled overnight Anthropic spend: acquire_or_reclaim_job_intake_lock
-- and the classification-retry path both let the recovery cron re-trigger
-- Stage 1/2 (expensive AI document processing) indefinitely — a job that
-- fails every time it runs (e.g. an Anthropic credit outage) never releases
-- its lock cleanly, the lock goes stale (~6 min), the cron reclaims it, and
-- the same expensive processing re-fires forever with no ceiling. This
-- mirrors the cap document_processing_jobs already has (attempts /
-- retry_or_fail_document_job, migration 034) — that table never had this
-- problem because it already capped retries; job_intake_locks/files had no
-- equivalent counter at all.

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS intake_recovery_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN files.intake_recovery_attempts IS
  'Count of times app/api/cron/intake-recovery/route.ts has reclaimed a stale job_intake_lock or retried classification for this file. Reset to 0 on legitimate progress path (files.intake_status leaving processing normally); once it reaches the route''s MAX_RECOVERY_ATTEMPTS the cron marks the file failed instead of retrying again, closing the infinite-reclaim loop that caused an uncontrolled overnight Anthropic spend.';

ALTER TABLE intake_recovery_runs
  ADD COLUMN IF NOT EXISTS files_permanently_failed integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN intake_recovery_runs.files_permanently_failed IS
  'Files this run marked intake_status=failed after hitting MAX_RECOVERY_ATTEMPTS, instead of retrying again.';
