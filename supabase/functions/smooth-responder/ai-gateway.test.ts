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

// ─── Attribution (Phase 0 completion) ────────────────────────────────────────

import {
  validateAttribution,
  AiAttributionError,
  guardedClaudeCall,
  type AiAttribution,
} from './ai-gateway.ts'

test('validateAttribution: builder with a real id is valid', () => {
  assert.equal(validateAttribution({ kind: 'builder', builderId: '00000000-0000-0000-0000-000000000001' }), null)
})

test('validateAttribution: builder with empty/whitespace id is invalid', () => {
  assert.match(validateAttribution({ kind: 'builder', builderId: '' }) ?? '', /no builderId/)
  assert.match(validateAttribution({ kind: 'builder', builderId: '   ' }) ?? '', /no builderId/)
})

test('validateAttribution: system with a stated reason is valid', () => {
  assert.equal(validateAttribution({ kind: 'system', reason: 'nightly network-rates aggregation' }), null)
})

test('validateAttribution: system without a reason is invalid', () => {
  assert.match(validateAttribution({ kind: 'system', reason: '' }) ?? '', /must state a reason/)
})

test('validateAttribution: missing or unknown-kind attribution is invalid', () => {
  assert.match(validateAttribution(null) ?? '', /missing/)
  assert.match(validateAttribution(undefined) ?? '', /missing/)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.match(validateAttribution({ kind: 'anonymous' } as any) ?? '', /unknown/)
})

// ── Stub-backed behavioral tests: attribution is actually recorded ──────────
// A minimal in-memory SupabaseLike implementing exactly the query chains the
// gateway uses — same approach as the Phase 0 verification harness, kept in
// the repo so these guarantees are re-proven on every test run.

function makeGatewayStub() {
  const db = {
    system_status: [
      { key: 'ai_circuit_breaker', value: { tripped: false, reason: null } },
      { key: 'ai_limits', value: { global_daily_cents: 2500, builder_daily_cents: 1000 } },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ai_operations: [] as any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpcCalls: [] as any[],
  }
  const stub = {
    from(table: string) {
      if (table === 'system_status') {
        return { select: () => ({ in: (_c: string, keys: string[]) =>
          Promise.resolve({ data: db.system_status.filter((r) => keys.includes(r.key)) }) }) }
      }
      if (table === 'ai_spend_daily') {
        return { select: () => ({ eq: () => Promise.resolve({ data: [] }) }) }
      }
      if (table === 'ai_operations') {
        return {
          select: () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const chain: any = {
              eq: () => chain, order: () => chain, limit: () => chain,
              maybeSingle: () => Promise.resolve({ data: null }),
            }
            return chain
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          insert: (row: any) => ({ select: () => ({ single: () => {
            const rec = { id: `op_${db.ai_operations.length + 1}`, ...row }
            db.ai_operations.push(rec)
            return Promise.resolve({ data: { id: rec.id } })
          } }) }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          update: (patch: any) => ({ eq: (_c: string, id: string) => {
            const rec = db.ai_operations.find((r) => r.id === id)
            if (rec) Object.assign(rec, patch)
            return Promise.resolve({ data: null, error: null })
          } }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc(fn: string, args: any) {
      db.rpcCalls.push({ fn, args })
      return Promise.resolve({ data: null, error: null })
    },
  }
  return { stub, db }
}

const FAKE_RESPONSE = { id: 'msg_x', usage: { input_tokens: 1000, output_tokens: 100 }, content: [] }

test('gateway: builder-attributed call records builder_id and attribution=builder', async () => {
  const { stub, db } = makeGatewayStub()
  const builderId = '00000000-0000-0000-0000-000000000001'
  await guardedClaudeCall(
    { supabase: stub, attribution: { kind: 'builder', builderId }, callSite: 'chat_extract_actions', model: 'claude-sonnet-4-6' },
    async () => FAKE_RESPONSE,
    { timeoutMs: 5000, maxRetries: 0 },
  )
  assert.equal(db.ai_operations.length, 1)
  assert.equal(db.ai_operations[0].builder_id, builderId)
  assert.equal(db.ai_operations[0].attribution, 'builder')
  assert.equal(db.ai_operations[0].status, 'succeeded')
  const spend = db.rpcCalls.find((c) => c.fn === 'record_ai_spend')
  assert.equal(spend.args.p_builder_id, builderId, 'spend attributed to the builder')
})

test('gateway: missing builderId fails safely — no provider call, no ledger row, no spend', async () => {
  const { stub, db } = makeGatewayStub()
  let providerCalls = 0
  await assert.rejects(
    () => guardedClaudeCall(
      { supabase: stub, attribution: { kind: 'builder', builderId: '' }, callSite: 'chat_extract_actions', model: 'claude-sonnet-4-6' },
      async () => { providerCalls++; return FAKE_RESPONSE },
    ),
    (err: unknown) => err instanceof AiAttributionError,
  )
  assert.equal(providerCalls, 0, 'provider never invoked')
  assert.equal(db.ai_operations.length, 0, 'no ledger row')
  assert.equal(db.rpcCalls.length, 0, 'no spend recorded')
})

test('gateway: system call is identifiable — attribution=system with reason, null builder_id, global-only spend', async () => {
  const { stub, db } = makeGatewayStub()
  await guardedClaudeCall(
    { supabase: stub, attribution: { kind: 'system', reason: 'scheduled maintenance reclassification' }, callSite: 'system_maintenance', model: 'claude-sonnet-4-6' },
    async () => FAKE_RESPONSE,
    { timeoutMs: 5000, maxRetries: 0 },
  )
  const op = db.ai_operations[0]
  assert.equal(op.attribution, 'system')
  assert.equal(op.attribution_detail, 'scheduled maintenance reclassification')
  assert.equal(op.builder_id, null, 'system call has no builder — explicitly, not by omission')
  const spend = db.rpcCalls.find((c) => c.fn === 'record_ai_spend')
  assert.equal(spend.args.p_builder_id, null, 'spend recorded against global only')
})

test('gateway: system call is exempt from the per-builder cap but still breaker-gated', async () => {
  const { stub, db } = makeGatewayStub()
  db.system_status[0].value = { tripped: true, reason: 'drill' }
  let providerCalls = 0
  await assert.rejects(
    () => guardedClaudeCall(
      { supabase: stub, attribution: { kind: 'system', reason: 'maintenance' }, callSite: 'system_maintenance', model: 'claude-sonnet-4-6' },
      async () => { providerCalls++; return FAKE_RESPONSE },
    ),
    (err: unknown) => err instanceof AiBudgetError,
  )
  assert.equal(providerCalls, 0, 'tripped breaker stops system calls too')
})
