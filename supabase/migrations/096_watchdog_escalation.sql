-- ============================================================
-- WorkA — Watchdog observability + bounded escalation (Option D)
-- ============================================================
-- Closes the gap found live investigating Run 4 of the post-fix reliability
-- test: enforce_estimate_deadlines()'s FOR UPDATE SKIP LOCKED loop has no
-- mathematically guaranteed finite time to terminal state -- a row can, in
-- principle, be skipped indefinitely with zero visibility into it happening.
-- Confirmed live: one estimate_runs row sat eligible (deadline_at < now(),
-- builder_status NULL) for over 2 hours across 130+ pg_cron ticks with only
-- one successful extension, and the exact contention mechanism could not be
-- proven (route invocations were shown NOT to self-overlap; a live,
-- continuously-churning production-wide candidate pool was found instead,
-- which is the more likely explanation, but not proven with certainty).
--
-- Deliberately NOT a redesign of enforce_estimate_deadlines() or its locking
-- strategy (SKIP LOCKED is untouched) -- this is a bounded, independent
-- safety net: track every tick whether an eligible row was *still* eligible
-- immediately after the normal watchdog ran (i.e. missed that tick), and if
-- a row accumulates enough consecutive misses, finalize it through a path
-- that does zero Anthropic work, reusing the exact same compute_builder_status
-- logic enforce_estimate_deadlines()'s own finalize branch already uses --
-- so the fallback is a strict subset of already-proven-safe logic, not a
-- new AI-calling code path. If the correct answer is "we can't finish this
-- estimate", escalation says so via NEEDS_REVIEW rather than ever retrying
-- more processing.

ALTER TABLE estimate_runs
  ADD COLUMN IF NOT EXISTS watchdog_first_eligible_at timestamptz,
  ADD COLUMN IF NOT EXISTS watchdog_last_eligible_at timestamptz,
  ADD COLUMN IF NOT EXISTS watchdog_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS watchdog_consecutive_misses integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS watchdog_total_misses integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS watchdog_escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS watchdog_escalation_reason text;

COMMENT ON COLUMN estimate_runs.watchdog_first_eligible_at IS
  'First time this row was observed matching the watchdog''s own eligibility predicate (deadline_at < now() AND builder_status IS NULL) and still eligible immediately AFTER that tick''s enforce_estimate_deadlines() call -- i.e. the first missed tick, not merely the first time deadline_at passed (a row resolved on its very first eligible tick never gets this set). Cleared back to NULL once the row resolves (extended or finalized).';
COMMENT ON COLUMN estimate_runs.watchdog_last_eligible_at IS
  'Most recent tick at which this row was still eligible after the normal watchdog ran.';
COMMENT ON COLUMN estimate_runs.watchdog_last_attempt_at IS
  'Most recent tick at which record_watchdog_post_tick observed and recorded this row, whether or not it resolved.';
COMMENT ON COLUMN estimate_runs.watchdog_consecutive_misses IS
  'Consecutive ticks this row has been observed still-eligible after enforce_estimate_deadlines() ran. Reset to 0 the moment the row resolves (extended or finalized). Drives the escalation threshold.';
COMMENT ON COLUMN estimate_runs.watchdog_total_misses IS
  'Lifetime count of missed ticks for this row, never reset -- observability only, not part of the escalation decision.';
COMMENT ON COLUMN estimate_runs.watchdog_escalated_at IS
  'When escalate_watchdog_finalize last acted on this row. Cleared back to NULL if the row later resolves normally without needing escalation again.';
COMMENT ON COLUMN estimate_runs.watchdog_escalation_reason IS
  'Human-readable reason recorded at escalation time (miss count context). Cleared alongside watchdog_escalated_at on resolution.';

-- ── record_watchdog_post_tick ────────────────────────────────────────────
-- Called once per recovery-cron tick, immediately after enforce_estimate_
-- deadlines() (step 0) has already run this same tick. Two effects, in one
-- statement each, both plain UPDATEs (no FOR UPDATE, no SKIP LOCKED) --
-- ordinary short row locks that never skip and never contend with the
-- SKIP LOCKED loop, since ticks are already proven not to overlap:
--   1. Reset bookkeeping for any row that resolved since we last looked
--      (deadline_at moved to the future via extension, or builder_status
--      is no longer NULL via finalization).
--   2. Increment bookkeeping for every row STILL eligible right now, i.e.
--      missed by this tick's normal watchdog pass. Returns those rows so
--      the caller (the recovery route) can apply the escalation decision.
CREATE OR REPLACE FUNCTION record_watchdog_post_tick()
RETURNS TABLE(
  estimate_run_id uuid,
  batch_id uuid,
  consecutive_misses integer,
  total_misses integer,
  first_eligible_at timestamptz
) AS $$
BEGIN
  UPDATE estimate_runs er
  SET watchdog_consecutive_misses = 0,
      watchdog_first_eligible_at = NULL,
      watchdog_escalated_at = NULL,
      watchdog_escalation_reason = NULL
  WHERE er.watchdog_first_eligible_at IS NOT NULL
    AND NOT (er.deadline_at < now() AND er.builder_status IS NULL);

  RETURN QUERY
  UPDATE estimate_runs er
  SET watchdog_first_eligible_at = COALESCE(er.watchdog_first_eligible_at, now()),
      watchdog_last_eligible_at = now(),
      watchdog_last_attempt_at = now(),
      watchdog_consecutive_misses = er.watchdog_consecutive_misses + 1,
      watchdog_total_misses = er.watchdog_total_misses + 1
  WHERE er.deadline_at < now() AND er.builder_status IS NULL
  RETURNING er.id, er.batch_id, er.watchdog_consecutive_misses, er.watchdog_total_misses, er.watchdog_first_eligible_at;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION record_watchdog_post_tick IS
  'Observability + miss-tracking for the deadline watchdog, called every recovery-cron tick right after enforce_estimate_deadlines(). Never calls Anthropic, never mutates builder_status/deadline_at itself -- purely bookkeeping. Returns every row still eligible after this tick''s normal watchdog pass (i.e. missed), for the caller to apply the escalation threshold against.';

-- ── escalate_watchdog_finalize ───────────────────────────────────────────
-- The bounded fallback. Deliberately reuses compute_builder_status() --
-- the exact same function enforce_estimate_deadlines()'s own finalize
-- branch already calls -- so this is a strict subset of already-proven-safe
-- logic, not a new decision path. Makes zero Anthropic calls (compute_
-- builder_status is pure SQL/DB reads), never touches total_ai_call_attempts
-- or the circuit breaker (nothing to bypass since neither is ever consulted
-- here), and is idempotent by construction: the FOR UPDATE ... WHERE
-- builder_status IS NULL guard means a row already finalized (by the normal
-- watchdog, or by a previous escalation call) simply doesn't match, and the
-- function returns escalated=false with no further writes -- safe to call
-- twice, safe to call on a row that resolved between the miss-check and the
-- escalation call itself. The FOR UPDATE here is a single-row, self-
-- contained lock exactly like enforce_estimate_deadlines()'s own finalize
-- branch -- no network or AI work happens while it is held.
CREATE OR REPLACE FUNCTION escalate_watchdog_finalize(p_estimate_run_id uuid)
RETURNS TABLE(escalated boolean, builder_status text, reason text) AS $$
DECLARE
  r record;
  v_cbs record;
BEGIN
  SELECT er.id, er.batch_id, er.status, er.watchdog_consecutive_misses, er.watchdog_total_misses
  INTO r
  FROM estimate_runs er
  WHERE er.id = p_estimate_run_id AND er.builder_status IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    escalated := false; builder_status := NULL; reason := 'already_terminal_or_missing';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT cbs.builder_status, cbs.reason INTO v_cbs FROM compute_builder_status(r.batch_id) cbs;

  UPDATE estimate_runs
  SET builder_status = v_cbs.builder_status,
      needs_review_reason = format(
        'Watchdog escalation: eligible for automatic finalization but missed %s consecutive recovery ticks (%s missed total). %s',
        r.watchdog_consecutive_misses, r.watchdog_total_misses, v_cbs.reason
      ),
      completed_at = COALESCE(completed_at, now()),
      watchdog_escalated_at = now(),
      watchdog_escalation_reason = format('missed %s consecutive ticks (%s total)', r.watchdog_consecutive_misses, r.watchdog_total_misses)
  WHERE id = p_estimate_run_id;

  INSERT INTO estimate_run_events (estimate_run_id, from_status, to_status, detail)
  VALUES (p_estimate_run_id, r.status, r.status, jsonb_build_object(
    'event', 'watchdog_escalated',
    'builder_status', v_cbs.builder_status,
    'reason', v_cbs.reason,
    'consecutive_misses', r.watchdog_consecutive_misses,
    'total_misses', r.watchdog_total_misses
  ));

  escalated := true; builder_status := v_cbs.builder_status; reason := v_cbs.reason;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION escalate_watchdog_finalize IS
  'Bounded fallback for a batch the normal SKIP LOCKED watchdog has missed too many consecutive times. Reuses compute_builder_status() -- the same function enforce_estimate_deadlines()''s finalize branch already calls -- so it makes zero Anthropic calls and never touches total_ai_call_attempts or the circuit breaker. Idempotent via FOR UPDATE ... WHERE builder_status IS NULL: a second call, or a call after the row resolved normally in between, is a safe no-op (escalated=false). Never resurrects a terminal row.';

-- Audit-row columns (same additive pattern as migration 095's
-- deadlines_enforced) so intake_recovery_runs carries per-tick watchdog
-- counts alongside every other recovery metric it already tracks.
ALTER TABLE intake_recovery_runs
  ADD COLUMN IF NOT EXISTS watchdog_escalations integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS watchdog_escalations_finalized integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN intake_recovery_runs.watchdog_escalations IS
  'Number of estimate_runs rows this tick attempted escalate_watchdog_finalize on (consecutive misses >= WATCHDOG_ESCALATION_THRESHOLD_MISSES).';
COMMENT ON COLUMN intake_recovery_runs.watchdog_escalations_finalized IS
  'Of watchdog_escalations, how many actually finalized (escalated=true) rather than being a no-op (already resolved between the miss-check and the escalation call).';

NOTIFY pgrst, 'reload schema';
