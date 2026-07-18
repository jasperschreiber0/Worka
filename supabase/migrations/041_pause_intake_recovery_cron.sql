-- 041_pause_intake_recovery_cron.sql
-- EMERGENCY: unschedules the pg_cron job added in migration 038
-- ('worka-intake-recovery'), which was found repeatedly re-triggering
-- smooth-responder against a batch that deterministically times out on
-- every attempt (16 Alfred St Woonona job — a 6-document batch including
-- Kitchen Elevation.pdf, the same file implicated in the earlier CPU-kill
-- incident), causing rapid, uncontrolled Anthropic spend. This is a
-- temporary kill switch, not a permanent removal — re-enable with
-- `SELECT cron.schedule('worka-intake-recovery', ...)` (see migration 038)
-- once the underlying stuck batch/file has been identified and resolved.

DO $$
BEGIN
  PERFORM cron.unschedule('worka-intake-recovery');
EXCEPTION WHEN OTHERS THEN
  NULL; -- already unscheduled or extension unavailable — safe to ignore
END $$;
