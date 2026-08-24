// ─── Watchdog escalation decision (Option D) ───────────────────────────────
//
// Pure decision logic for the deadline-watchdog escalation threshold. Kept
// dependency-free and separate from app/api/cron/intake-recovery/route.ts so
// it's unit-testable without a live database, mirroring the
// pruneExpiredStage6Slots/canClaimStage6Slot pattern in
// supabase/functions/smooth-responder/pipeline-logic.ts.
//
// Threshold derivation (per explicit instruction to inspect the existing
// SLA/deadline design before picking numbers, not just take the suggested
// 10/30 minutes on faith):
//
// enforce_estimate_deadlines() (migrations 078/089) gives an estimate_runs
// row an initial 15-minute deadline, and up to 3 extensions of 6 minutes
// each when it matches the extension-eligible predicate — a worst-case
// *legitimate* lifetime of 15 + 3*6 = 33 minutes before the row is REQUIRED
// to be finalized on its own. Critically, each successful extension moves
// deadline_at into the future, which means the row no longer matches
// record_watchdog_post_tick's eligibility predicate (deadline_at < now())
// and its watchdog_consecutive_misses counter is reset to 0 by that
// function's own first UPDATE. So a healthy row cycling through its normal
// 33-minute worst-case lifetime never accumulates consecutive misses at
// all — misses only accumulate for a row that is eligible (deadline
// passed, not yet resolved) and then observed STILL eligible on the very
// next tick, which is exactly the SKIP LOCKED starvation this option exists
// to bound, not a symptom of the normal extension cycle.
//
// pg_cron fires this route every 1 minute (migration 038), so
// watchdog_consecutive_misses is directly a minute count. The user's
// suggested 10-minute warning / 30-minute escalation values are adopted
// as-is: 10 minutes is far longer than any single tick's own duration
// (observed ~300ms in production, see the overlap-forensics diagnostic)
// so it cannot false-positive on ordinary tick jitter, and 30 minutes is
// comfortably inside "something is structurally wrong", not a value that
// could ever be reached by the legitimate 33-minute extension lifecycle
// (which resets the counter on every successful extension, as above) —
// the only way to reach 30 consecutive misses is 30 straight ticks where
// the row was eligible and NOT touched by the normal watchdog pass.
export const WATCHDOG_TICK_INTERVAL_MS = 60_000

export const WATCHDOG_WARNING_THRESHOLD_MISSES = 10
export const WATCHDOG_ESCALATION_THRESHOLD_MISSES = 30

export type WatchdogDecision = 'ok' | 'warning' | 'escalate'

export interface WatchdogMissObservation {
  estimateRunId: string
  batchId: string
  consecutiveMisses: number
  totalMisses: number
  firstEligibleAt: string | null
}

// Pure decision: given one row's consecutive-miss count (as returned by
// record_watchdog_post_tick), decide whether it's still within normal
// bounds, deserves a warning log, or must be escalated to the bypass
// fallback (escalate_watchdog_finalize). Escalation takes priority over
// warning at the boundary (>= threshold, not >).
export function decideWatchdogAction(
  consecutiveMisses: number,
  warningThreshold: number = WATCHDOG_WARNING_THRESHOLD_MISSES,
  escalationThreshold: number = WATCHDOG_ESCALATION_THRESHOLD_MISSES,
): WatchdogDecision {
  if (consecutiveMisses >= escalationThreshold) return 'escalate'
  if (consecutiveMisses >= warningThreshold) return 'warning'
  return 'ok'
}

// Partitions a tick's full set of missed-row observations (the rows
// returned by record_watchdog_post_tick) into the three buckets, so the
// caller can log/escalate each bucket distinctly without re-deriving the
// per-row decision inline at the call site.
export interface PartitionedWatchdogObservations {
  ok: WatchdogMissObservation[]
  warning: WatchdogMissObservation[]
  escalate: WatchdogMissObservation[]
}

export function partitionWatchdogObservations(
  observations: WatchdogMissObservation[],
  warningThreshold: number = WATCHDOG_WARNING_THRESHOLD_MISSES,
  escalationThreshold: number = WATCHDOG_ESCALATION_THRESHOLD_MISSES,
): PartitionedWatchdogObservations {
  const result: PartitionedWatchdogObservations = { ok: [], warning: [], escalate: [] }
  for (const obs of observations) {
    const decision = decideWatchdogAction(obs.consecutiveMisses, warningThreshold, escalationThreshold)
    result[decision === 'ok' ? 'ok' : decision === 'warning' ? 'warning' : 'escalate'].push(obs)
  }
  return result
}

// Human-readable escalation reason string, used both for the
// estimate_runs.watchdog_escalation_reason column (as a fallback if the SQL
// function's own format() output is ever unavailable to the caller) and for
// the route's structured log line.
export function formatWatchdogEscalationReason(obs: WatchdogMissObservation): string {
  const ageMs = obs.firstEligibleAt ? Date.now() - new Date(obs.firstEligibleAt).getTime() : null
  const ageMinutes = ageMs !== null ? Math.round(ageMs / 60_000) : null
  return (
    `estimate_run ${obs.estimateRunId} (batch ${obs.batchId}) missed ${obs.consecutiveMisses} ` +
    `consecutive watchdog ticks (${obs.totalMisses} total)` +
    (ageMinutes !== null ? `, first eligible ~${ageMinutes}min ago` : '')
  )
}
