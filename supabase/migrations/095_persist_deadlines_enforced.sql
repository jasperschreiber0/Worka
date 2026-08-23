-- ── 095: persist deadlines_enforced on the recovery audit row ───────────────
--
-- Observability-only, no behavior change. app/api/cron/intake-recovery/
-- route.ts already computes summary.deadlines_enforced (the count of rows
-- enforce_estimate_deadlines() actually finalized this tick) and includes
-- it in the JSON HTTP response and per-row logs — but its own INSERT into
-- intake_recovery_runs never wrote it to the table, so it was invisible to
-- anyone querying the audit trail after the fact (only live in ephemeral
-- function log retention or the HTTP response of that one request).
--
-- Found live diagnosing an 8h56m-stuck estimate_runs row: confirming
-- whether enforce_estimate_deadlines() had ever actually matched/finalized
-- that specific row required six separate diagnostic queries (function
-- body comparison, pg_locks, pg_cron history, a direct dry-run) because
-- intake_recovery_runs.errors=[] only proves the RPC didn't throw, not
-- that it did anything. With this column, "was this row ever finalized,
-- and on which tick" becomes a single SELECT.

ALTER TABLE intake_recovery_runs
  ADD COLUMN IF NOT EXISTS deadlines_enforced integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN intake_recovery_runs.deadlines_enforced IS
  'Count of estimate_runs rows enforce_estimate_deadlines() actually finalized (set builder_status) this tick — distinguishes "the watchdog ran and found nothing eligible" from "the watchdog ran and finalized N rows" without needing to cross-reference estimate_run_events. Was already computed in route.ts (summary.deadlines_enforced) but never persisted before this migration.';
