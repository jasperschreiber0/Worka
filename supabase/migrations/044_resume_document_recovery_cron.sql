-- 044_resume_document_recovery_cron.sql
-- Re-schedules the pg_cron job unscheduled by migration 041's emergency
-- stop, now that the route itself (app/api/cron/intake-recovery/route.ts)
-- splits recovery into two independently-gated halves:
--
--   DOCUMENT_RECOVERY_DISABLED = false — steps 1-3 (reclaim_stale_document_
--     jobs, recompute_stalled_batches, find_batches_with_claimable_work).
--     None of these call Anthropic; they only reclaim/resume
--     document-worker's own text-extraction queue. Safe to run on a fixed
--     schedule again.
--
--   AI_RECOVERY_DISABLED = true — steps 4-5 (job_intake_lock reclaim,
--     stuck-classification retry), both of which can fire smooth-responder
--     and therefore call Anthropic. Deliberately left disabled at the code
--     level even though this migration re-enables the cron's SCHEDULE —
--     the route's own AI_RECOVERY_DISABLED flag is what actually keeps
--     those two steps inert, not the schedule. Re-enable that flag
--     separately, in code, only after a manually-observed production run
--     of the classification/retry-cap redesign (see CLAUDE.md "Anthropic
--     failure classification and retry redesign").
--
-- This is why re-scheduling the cron here is safe on its own: with
-- AI_RECOVERY_DISABLED still true in the route, every minute's run does
-- real, useful, zero-cost document-recovery work (steps 1-3) and logs
-- 'recovery_ai_steps_skipped' for the other half — it cannot reach
-- Anthropic regardless of how often it fires.

DO $$
BEGIN
  PERFORM cron.unschedule('worka-intake-recovery');
EXCEPTION WHEN OTHERS THEN
  NULL; -- not currently scheduled (migration 041) — nothing to unschedule
END $$;

SELECT cron.schedule(
  'worka-intake-recovery',
  '* * * * *', -- every minute, same cadence as migration 038 originally set
  $$SELECT trigger_intake_recovery();$$
);

COMMENT ON EXTENSION pg_cron IS
  'Schedules trigger_intake_recovery() every minute. As of migration 044, the target route internally gates AI-calling recovery steps (4-5) behind their own AI_RECOVERY_DISABLED flag, independent of this schedule — this cron firing does not by itself imply Anthropic calls can happen.';
