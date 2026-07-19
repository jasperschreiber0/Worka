// Unit tests for the pure parts of the AI gateway (pricing, budget decision,
// input hashing). Runs under `npm run test` (node --experimental-strip-types)
// exactly like pipeline-logic.test.ts — no database, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  estimateCostCents,
  decideBudget,
  hashAiInput,
  AiBudgetError,
  AI_PRICING_CENTS_PER_MTOK,
  type BudgetState,
} from './ai-gateway.ts'

function baseState(overrides: Partial<BudgetState> = {}): BudgetState {
  return {
    breakerTripped: false,
    breakerReason: null,
    breakerKnown: true,
    builderDayCents: 0,
    globalDayCents: 0,
    builderLimitCents: 1000,
    globalLimitCents: 2500,
    ...overrides,
  }
}

// ─── estimateCostCents ───────────────────────────────────────────────────────

test('estimateCostCents: known model uses its pricing table entry', () => {
  // 1M input + 1M output tokens on claude-sonnet-4-6 = 300 + 1500 cents
  assert.equal(estimateCostCents('claude-sonnet-4-6', 1_000_000, 1_000_000), 1800)
})

test('estimateCostCents: typical stage call is in a sane range', () => {
  // ~60k input, ~10k output — the shape of a real Stage 3 call
  const cents = estimateCostCents('claude-sonnet-4-6', 60_000, 10_000)
  assert.ok(cents > 10 && cents < 60, `expected tens of cents, got ${cents}`)
})

test('estimateCostCents: unknown model falls back to the expensive default, never zero', () => {
  const cents = estimateCostCents('some-future-model', 100_000, 10_000)
  assert.ok(cents > 0, 'unknown model must never be priced at zero')
  const known = estimateCostCents('claude-sonnet-4-6', 100_000, 10_000)
  assert.ok(cents >= known, 'fallback pricing must be at least as expensive as known models')
})

test('estimateCostCents: zero tokens costs zero', () => {
  assert.equal(estimateCostCents('claude-sonnet-4-6', 0, 0), 0)
})

test('pricing table: every entry has positive input and output rates', () => {
  for (const [model, p] of Object.entries(AI_PRICING_CENTS_PER_MTOK)) {
    assert.ok(p.input > 0 && p.output > 0, `${model} has a non-positive rate`)
  }
})

// ─── decideBudget ────────────────────────────────────────────────────────────

test('decideBudget: allows under all limits with breaker untripped', () => {
  const d = decideBudget(baseState({ builderDayCents: 500, globalDayCents: 1200 }))
  assert.equal(d.allowed, true)
  assert.equal(d.reason, null)
})

test('decideBudget: refuses when the breaker is tripped, with the reason surfaced', () => {
  const d = decideBudget(baseState({ breakerTripped: true, breakerReason: 'manual stop' }))
  assert.equal(d.allowed, false)
  assert.match(d.reason ?? '', /breaker/i)
  assert.match(d.reason ?? '', /manual stop/)
})

test('decideBudget: fails closed when breaker state is unknown', () => {
  const d = decideBudget(baseState({ breakerKnown: false }))
  assert.equal(d.allowed, false)
  assert.match(d.reason ?? '', /failing closed/i)
})

test('decideBudget: refuses at exactly the global limit (>=, not >)', () => {
  const d = decideBudget(baseState({ globalDayCents: 2500 }))
  assert.equal(d.allowed, false)
  assert.match(d.reason ?? '', /global/i)
})

test('decideBudget: refuses at exactly the builder limit', () => {
  const d = decideBudget(baseState({ builderDayCents: 1000 }))
  assert.equal(d.allowed, false)
  assert.match(d.reason ?? '', /this account/i)
})

test('decideBudget: global limit takes precedence over builder limit in the reason', () => {
  const d = decideBudget(baseState({ builderDayCents: 1000, globalDayCents: 2500 }))
  assert.equal(d.allowed, false)
  assert.match(d.reason ?? '', /global/i)
})

test('decideBudget: one builder at their cap does not block a different builder', () => {
  // The state passed in is already scoped to the calling builder — a builder
  // with zero spend today is allowed even when global spend is nonzero.
  const d = decideBudget(baseState({ builderDayCents: 0, globalDayCents: 1500 }))
  assert.equal(d.allowed, true)
})

// ─── hashAiInput ─────────────────────────────────────────────────────────────

test('hashAiInput: identical parts hash identically', async () => {
  const a = await hashAiInput(['system prompt', { role: 'user', content: 'facts...' }])
  const b = await hashAiInput(['system prompt', { role: 'user', content: 'facts...' }])
  assert.equal(a, b)
})

test('hashAiInput: any content change changes the hash', async () => {
  const a = await hashAiInput(['system prompt', 'fact base v1'])
  const b = await hashAiInput(['system prompt', 'fact base v2'])
  assert.notEqual(a, b)
})

test('hashAiInput: produces a 64-char hex sha-256', async () => {
  const h = await hashAiInput(['x'])
  assert.match(h, /^[0-9a-f]{64}$/)
})

// ─── AiBudgetError ───────────────────────────────────────────────────────────

test('AiBudgetError: carries the budget_refused classification and is an Error', () => {
  const e = new AiBudgetError('limit reached')
  assert.ok(e instanceof Error)
  assert.equal(e.classification, 'budget_refused')
  assert.equal(e.name, 'AiBudgetError')
})
