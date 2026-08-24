// Regression tests for Option D — watchdog observability + bounded
// escalation. Split between pure-function tests (Tests A-C, the actual
// threshold decision logic) and source-regression-guard tests reading the
// SQL migration / route.ts text directly (Tests D-I) — the same pattern
// lib/intake-recovery-deadlines-persisted.test.ts and
// lib/intake-recovery-scheduler.test.ts already use in this codebase,
// since there is no live-DB test harness (see CLAUDE.md "Commands").
// Tests D-I in particular verify *safety invariants that must hold no
// matter what a live database does* (idempotency guard present, no
// Anthropic call in the fallback path, single-row lock only, etc.) by
// asserting the exact SQL text implements them — this is deliberately not
// a live simulation of concurrent transactions, which this test runner
// cannot express without a database.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  decideWatchdogAction,
  partitionWatchdogObservations,
  formatWatchdogEscalationReason,
  WATCHDOG_WARNING_THRESHOLD_MISSES,
  WATCHDOG_ESCALATION_THRESHOLD_MISSES,
  type WatchdogMissObservation,
} from './watchdog-escalation.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

function readRepoFile(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf-8')
}

function obs(overrides: Partial<WatchdogMissObservation> = {}): WatchdogMissObservation {
  return {
    estimateRunId: 'er-1',
    batchId: 'batch-1',
    consecutiveMisses: 0,
    totalMisses: 0,
    firstEligibleAt: null,
    ...overrides,
  }
}

// ── Test A: eligible batch processed normally, no escalation ──────────────
test('Test A: a row with zero consecutive misses is "ok", never warned or escalated', () => {
  assert.equal(decideWatchdogAction(0), 'ok')
  const { ok, warning, escalate } = partitionWatchdogObservations([obs({ consecutiveMisses: 0 })])
  assert.equal(ok.length, 1)
  assert.equal(warning.length, 0)
  assert.equal(escalate.length, 0)
})

// ── Test B: eligible batch missed repeatedly, warning after warning threshold ──
test('Test B: consecutive misses below the warning threshold stay "ok"; at/above it becomes "warning" (not escalate)', () => {
  assert.equal(decideWatchdogAction(WATCHDOG_WARNING_THRESHOLD_MISSES - 1), 'ok')
  assert.equal(decideWatchdogAction(WATCHDOG_WARNING_THRESHOLD_MISSES), 'warning')
  assert.equal(decideWatchdogAction(WATCHDOG_ESCALATION_THRESHOLD_MISSES - 1), 'warning')

  const { warning, escalate } = partitionWatchdogObservations([
    obs({ estimateRunId: 'er-warn', consecutiveMisses: WATCHDOG_WARNING_THRESHOLD_MISSES }),
  ])
  assert.equal(warning.length, 1)
  assert.equal(warning[0].estimateRunId, 'er-warn')
  assert.equal(escalate.length, 0)
})

// ── Test C: eligible batch exceeds escalation threshold, fallback executes ──
test('Test C: consecutive misses at/above the escalation threshold triggers "escalate"', () => {
  assert.equal(decideWatchdogAction(WATCHDOG_ESCALATION_THRESHOLD_MISSES), 'escalate')
  assert.equal(decideWatchdogAction(WATCHDOG_ESCALATION_THRESHOLD_MISSES + 50), 'escalate')

  const { escalate } = partitionWatchdogObservations([
    obs({ estimateRunId: 'er-esc', consecutiveMisses: WATCHDOG_ESCALATION_THRESHOLD_MISSES }),
  ])
  assert.equal(escalate.length, 1)
  assert.equal(escalate[0].estimateRunId, 'er-esc')
})

test('the escalation threshold is comfortably above the normal 15min + 3x6min extension lifecycle boundary reasoning documented in watchdog-escalation.ts', () => {
  // Not a claim that 33 minutes is itself a bound on consecutive misses (a
  // healthy row resets its miss counter on every successful extension —
  // see the module's own header comment) -- just a guard that nobody
  // silently drops the escalation threshold to something that could
  // plausibly fire during a single normal extension window.
  assert.ok(WATCHDOG_ESCALATION_THRESHOLD_MISSES >= 30)
  assert.ok(WATCHDOG_WARNING_THRESHOLD_MISSES < WATCHDOG_ESCALATION_THRESHOLD_MISSES)
})

test('formatWatchdogEscalationReason includes the batch id, estimate_run id, and miss counts', () => {
  const reason = formatWatchdogEscalationReason(
    obs({ estimateRunId: 'er-x', batchId: 'batch-y', consecutiveMisses: 30, totalMisses: 45 }),
  )
  assert.match(reason, /er-x/)
  assert.match(reason, /batch-y/)
  assert.match(reason, /30/)
  assert.match(reason, /45/)
})

// ── Test D & E: idempotency of escalate_watchdog_finalize ─────────────────
// escalate_watchdog_finalize's idempotency (a second call, or a call after
// the row already resolved, is a safe no-op) is a database-transactional
// guarantee (FOR UPDATE ... WHERE builder_status IS NULL) that this test
// runner cannot exercise against a live database. Verified instead by
// asserting the exact guard clause is present in the deployed migration
// SQL -- the same technique lib/intake-recovery-deadlines-persisted.test.ts
// already uses for a different function's safety property.
const migration096 = readRepoFile('supabase/migrations/096_watchdog_escalation.sql')

test('Test D/E: escalate_watchdog_finalize guards on builder_status IS NULL under FOR UPDATE, and returns escalated=false with no writes when the row does not match (already terminal / already escalated)', () => {
  assert.match(migration096, /WHERE er\.id = p_estimate_run_id AND er\.builder_status IS NULL/)
  assert.match(migration096, /FOR UPDATE/)
  assert.match(migration096, /IF NOT FOUND THEN/)
  // The not-found branch must return escalated=false and perform no writes
  // before the FOR UPDATE row lock is released (RETURN immediately after).
  const notFoundBlock = migration096.slice(
    migration096.indexOf('IF NOT FOUND THEN'),
    migration096.indexOf('IF NOT FOUND THEN') + 200,
  )
  assert.match(notFoundBlock, /escalated := false/)
  assert.match(notFoundBlock, /RETURN;/)
})

test('Test D/E: escalate_watchdog_finalize never runs its UPDATE/INSERT writes inside the NOT FOUND branch (writes are strictly after it)', () => {
  const notFoundIdx = migration096.indexOf('IF NOT FOUND THEN')
  assert.ok(notFoundIdx > -1, 'expected the not-found short-circuit block to exist')
  const endIfIdx = migration096.indexOf('END IF;', notFoundIdx)
  assert.ok(endIfIdx > notFoundIdx, 'expected the not-found branch to be closed with END IF;')
  const notFoundBlock = migration096.slice(notFoundIdx, endIfIdx)
  assert.match(notFoundBlock, /RETURN;/)
  assert.doesNotMatch(notFoundBlock, /UPDATE estimate_runs/)
  assert.doesNotMatch(notFoundBlock, /INSERT INTO/)

  const updateIdx = migration096.indexOf('UPDATE estimate_runs\n  SET builder_status')
  assert.ok(updateIdx > endIfIdx, 'the finalize UPDATE must come after the not-found short-circuit, never before it')
})

// ── Test F: AI attempt count at/near the ceiling — escalation cannot cause
// an additional unsafe AI call ────────────────────────────────────────────
test('Test F: escalate_watchdog_finalize never calls Anthropic, never touches total_ai_call_attempts, and only reads via compute_builder_status (pure DB reads)', () => {
  const fnStart = migration096.indexOf('CREATE OR REPLACE FUNCTION escalate_watchdog_finalize')
  const fnEnd = migration096.indexOf('$$ LANGUAGE plpgsql;', fnStart)
  const fnBody = migration096.slice(fnStart, fnEnd)

  assert.doesNotMatch(fnBody, /anthropic/i)
  assert.doesNotMatch(fnBody, /total_ai_call_attempts/)
  assert.doesNotMatch(fnBody, /ai_operations/)
  assert.doesNotMatch(fnBody, /smooth-responder/i)
  assert.doesNotMatch(fnBody, /http_post|net\.http/i)
  assert.match(fnBody, /compute_builder_status\(r\.batch_id\)/)
})

// ── Test G: circuit breaker tripped — escalation cannot bypass it ─────────
test('Test G: escalate_watchdog_finalize never reads or writes system_status / ai_circuit_breaker', () => {
  const fnStart = migration096.indexOf('CREATE OR REPLACE FUNCTION escalate_watchdog_finalize')
  const fnEnd = migration096.indexOf('$$ LANGUAGE plpgsql;', fnStart)
  const fnBody = migration096.slice(fnStart, fnEnd)
  assert.doesNotMatch(fnBody, /system_status/)
  assert.doesNotMatch(fnBody, /ai_circuit_breaker/)
})

const routeSource = readRepoFile('app/api/cron/intake-recovery/route.ts')

test('Test G (route level): the watchdog escalation step is not gated on AI_RECOVERY_DISABLED being false or the breaker being untripped, but escalate_watchdog_finalize itself still cannot make an AI call regardless of that', () => {
  // Escalation must run even while AI recovery is disabled/breaker tripped
  // (it makes zero Anthropic calls, so there's nothing to gate) -- assert
  // the watchdog block appears before the AI_RECOVERY_DISABLED check, i.e.
  // is not nested inside it.
  const watchdogIdx = routeSource.indexOf("supabase.rpc('record_watchdog_post_tick')")
  const aiGateIdx = routeSource.indexOf('AI_RECOVERY_DISABLED || aiCircuitBreakerTripped')
  assert.ok(watchdogIdx > -1, 'expected record_watchdog_post_tick to be called from route.ts')
  assert.ok(aiGateIdx > -1, 'expected the AI recovery gate check to exist')
  assert.ok(watchdogIdx < aiGateIdx, 'watchdog step must run before (outside) the AI-recovery gate')
})

// ── Test H: batch locked during normal processing — escalation cannot
// deadlock or wait indefinitely on the same lock ───────────────────────────
test('Test H: escalate_watchdog_finalize takes only a single-row FOR UPDATE on estimate_runs (by primary key) and never locks job_intake_locks or document_processing_batches', () => {
  const fnStart = migration096.indexOf('CREATE OR REPLACE FUNCTION escalate_watchdog_finalize')
  const fnEnd = migration096.indexOf('$$ LANGUAGE plpgsql;', fnStart)
  const fnBody = migration096.slice(fnStart, fnEnd)

  // Exactly one FOR UPDATE, scoped to a single row via a primary-key
  // equality predicate -- not a table/range lock.
  const forUpdateMatches = fnBody.match(/FOR UPDATE/g) ?? []
  assert.equal(forUpdateMatches.length, 1)
  assert.match(fnBody, /WHERE er\.id = p_estimate_run_id AND er\.builder_status IS NULL\s*\n\s*FOR UPDATE/)

  assert.doesNotMatch(fnBody, /job_intake_locks/)
  assert.doesNotMatch(fnBody, /document_processing_batches\s+(FOR|.*FOR UPDATE)/)
})

test('Test H: record_watchdog_post_tick uses plain UPDATEs only — no FOR UPDATE / SKIP LOCKED — so it can never contend with enforce_estimate_deadlines\' own row locks', () => {
  const fnStart = migration096.indexOf('CREATE OR REPLACE FUNCTION record_watchdog_post_tick')
  const fnEnd = migration096.indexOf('$$ LANGUAGE plpgsql;', fnStart)
  const fnBody = migration096.slice(fnStart, fnEnd)
  assert.doesNotMatch(fnBody, /FOR UPDATE/)
  assert.doesNotMatch(fnBody, /SKIP LOCKED/)
})

// ── Test I: synthetic expired batch, watchdog -> escalation -> terminal
// state, zero Anthropic calls -- this is the mandatory post-deployment
// PRODUCTION verification per the task spec, not something this offline
// test runner can perform against a live database. This test instead
// asserts the wiring that verification depends on is present and correctly
// ordered, as a pre-condition check before that verification is run. ────────
test('Test I (pre-condition check): route.ts calls record_watchdog_post_tick, partitions results, and calls escalate_watchdog_finalize only for the escalate bucket, logging watchdog_escalation_attempt/_result with the required fields', () => {
  assert.match(routeSource, /supabase\.rpc\('record_watchdog_post_tick'\)/)
  assert.match(routeSource, /supabase\.rpc\('escalate_watchdog_finalize'/)
  assert.match(routeSource, /partitionWatchdogObservations\(observed\)/)

  // escalate_watchdog_finalize must only be invoked inside the `for (const obs of escalate)` loop
  const escalateLoopIdx = routeSource.indexOf('for (const obs of escalate)')
  const rpcCallIdx = routeSource.indexOf("supabase.rpc('escalate_watchdog_finalize'")
  assert.ok(escalateLoopIdx > -1 && rpcCallIdx > escalateLoopIdx)

  // Required strong-logging fields at escalation attempt time.
  const attemptLogIdx = routeSource.indexOf("log('watchdog_escalation_attempt'")
  const attemptLogBlock = routeSource.slice(attemptLogIdx, attemptLogIdx + 700)
  for (const field of [
    'estimate_run_id', 'batch_id', 'consecutive_misses', 'total_misses',
    'current_stage', 'ai_attempt_count', 'deadline_extensions_used', 'lock_held', 'reason',
  ]) {
    assert.match(attemptLogBlock, new RegExp(field), `expected watchdog_escalation_attempt log to include ${field}`)
  }

  // Required fields at the result/outcome log.
  const resultLogIdx = routeSource.indexOf("log('watchdog_escalation_result'")
  const resultLogBlock = routeSource.slice(resultLogIdx, resultLogIdx + 500)
  for (const field of ['escalated', 'final_builder_status', 'fallback_succeeded']) {
    assert.match(resultLogBlock, new RegExp(field), `expected watchdog_escalation_result log to include ${field}`)
  }
})

test('Test I (pre-condition check): the intake_recovery_runs audit insert persists watchdog_escalations counts, and migration 096 adds those columns', () => {
  assert.match(routeSource, /watchdog_escalations: summary\.watchdog_escalations/)
  assert.match(routeSource, /watchdog_escalations_finalized: summary\.watchdog_escalations_finalized/)
  assert.match(migration096, /ADD COLUMN IF NOT EXISTS watchdog_escalations integer/)
  assert.match(migration096, /ADD COLUMN IF NOT EXISTS watchdog_escalations_finalized integer/)
})

test('escalate_watchdog_finalize records an estimate_run_events row with event=watchdog_escalated, matching the existing deadline_enforced event pattern', () => {
  assert.match(migration096, /'event',\s*'watchdog_escalated'/)
  assert.match(migration096, /INSERT INTO estimate_run_events/)
})

test('the escalation reason is persisted onto needs_review_reason and watchdog_escalation_reason, and completed_at is set (never overwritten if already set)', () => {
  const fnStart = migration096.indexOf('CREATE OR REPLACE FUNCTION escalate_watchdog_finalize')
  const fnEnd = migration096.indexOf('$$ LANGUAGE plpgsql;', fnStart)
  const fnBody = migration096.slice(fnStart, fnEnd)
  assert.match(fnBody, /needs_review_reason = format\(/)
  assert.match(fnBody, /completed_at = COALESCE\(completed_at, now\(\)\)/)
})

test('record_watchdog_post_tick resets bookkeeping (including watchdog_escalated_at/reason) once a row is no longer eligible, so a resolved row does not carry a stale escalation flag forward', () => {
  const fnStart = migration096.indexOf('CREATE OR REPLACE FUNCTION record_watchdog_post_tick')
  const fnEnd = migration096.indexOf('$$ LANGUAGE plpgsql;', fnStart)
  const fnBody = migration096.slice(fnStart, fnEnd)
  assert.match(fnBody, /watchdog_consecutive_misses = 0/)
  assert.match(fnBody, /watchdog_first_eligible_at = NULL/)
  assert.match(fnBody, /watchdog_escalated_at = NULL/)
  assert.match(fnBody, /watchdog_escalation_reason = NULL/)
  assert.match(fnBody, /NOT \(er\.deadline_at < now\(\) AND er\.builder_status IS NULL\)/)
})
