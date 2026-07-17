import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateQualityGate, REVIEW_CONFIDENCE_THRESHOLD, REVIEW_EXPOSURE_PCT_THRESHOLD } from './quality-gate.ts'
import type { QualityGateLineItem } from './quality-gate.ts'

// Relative, .ts-suffixed import (not the @/* alias) so this resolves
// identically under plain `node --experimental-strip-types --test` and
// under Next.js/webpack — same reasoning as pipeline-logic.test.ts. This is
// also why decideQuoteSendPolicy/buildRiskAcknowledgementSnapshot
// (quote-quality-policy.ts) aren't unit-tested here: that file imports
// DEMO_QUOTE/DEMO_LINE_ITEMS via the @/ alias, which plain node can't
// resolve. Their correctness reduces almost entirely to gate.review_reasons
// being right (tested below) plus a one-line field mapping.

function item(overrides: Partial<QualityGateLineItem> & { id: string }): QualityGateLineItem {
  return {
    description: 'Line item',
    total: 1000,
    rate: 100,
    pricing_type: 'measured',
    is_assumption: false,
    assumption_status: null,
    ...overrides,
  }
}

// ─── Scenario 1: clean quote → READY ────────────────────────────────────────

test('quality gate: clean quote with no assumptions/PC-PS and high confidence is READY', () => {
  const items = [item({ id: '1', total: 5000 }), item({ id: '2', total: 5000 })]
  const result = evaluateQualityGate({
    overall_confidence: 90,
    unresolved_count: 0,
    missing_trades: [],
    top_risks: [],
    total_cost: 10000,
    items,
  })
  assert.equal(result.state, 'ready')
  assert.deepEqual(result.blocked_reasons, [])
  assert.deepEqual(result.review_reasons, [])
  assert.equal(result.exposure.exposed_value, 0)
})

// ─── Scenario 2: low confidence → REVIEW_REQUIRED ───────────────────────────

test('quality gate: confidence below threshold triggers REVIEW_REQUIRED even with empty top_risks', () => {
  const items = [item({ id: '1', total: 10000 })]
  const result = evaluateQualityGate({
    overall_confidence: REVIEW_CONFIDENCE_THRESHOLD - 5,
    unresolved_count: 0,
    missing_trades: [],
    top_risks: [], // deliberately empty — the review reason must still be present
    total_cost: 10000,
    items,
  })
  assert.equal(result.state, 'review_required')
  assert.ok(result.review_reasons.some((r) => r.includes('confidence')))
})

// ─── Scenario 3: high exposure → REVIEW_REQUIRED ────────────────────────────

test('quality gate: exposure at or above threshold triggers REVIEW_REQUIRED regardless of confidence', () => {
  const items = [
    item({ id: '1', total: 8500, pricing_type: 'measured' }),
    item({ id: '2', total: 1500, pricing_type: 'provisional_sum' }),
  ]
  const result = evaluateQualityGate({
    overall_confidence: 95,
    unresolved_count: 0,
    missing_trades: [],
    top_risks: [],
    total_cost: 10000,
    items,
  })
  assert.equal(result.exposure.exposed_pct, 15)
  assert.ok(result.exposure.exposed_pct >= REVIEW_EXPOSURE_PCT_THRESHOLD)
  assert.equal(result.state, 'review_required')
  assert.ok(result.review_reasons.some((r) => r.includes('exposed')))
})

// ─── Scenario 4: unresolved assumption → BLOCKED ────────────────────────────

test('quality gate: unresolved assumption BLOCKS regardless of confidence or exposure', () => {
  const items = [
    item({ id: '1', total: 9000 }),
    item({ id: '2', total: 1000, is_assumption: true, assumption_status: 'unresolved' }),
  ]
  const result = evaluateQualityGate({
    overall_confidence: 95,
    unresolved_count: 1,
    missing_trades: [],
    top_risks: [],
    total_cost: 10000,
    items,
  })
  assert.equal(result.state, 'blocked')
  assert.ok(result.blocked_reasons.some((r) => r.includes('unresolved assumption')))
  // BLOCKED takes precedence over exposure — no acknowledgement can fix this
  assert.equal(result.review_reasons.length, 0)
})

// ─── Scenario 5: missing trade → BLOCKED ────────────────────────────────────

test('quality gate: a missing in-scope trade BLOCKS', () => {
  const items = [item({ id: '1', total: 10000 })]
  const result = evaluateQualityGate({
    overall_confidence: 95,
    unresolved_count: 0,
    missing_trades: [4], // e.g. Electrical
    top_risks: [],
    total_cost: 10000,
    items,
  })
  assert.equal(result.state, 'blocked')
  assert.deepEqual(result.missing_trade_ids, [4])
  assert.ok(result.blocked_reasons.some((r) => r.includes('trade')))
})

// ─── Scenario 6: unpriced item → BLOCKED, excluded from exposure ────────────

test('quality gate: a non-excluded unpriced item BLOCKS and is excluded from exposure (not silently dropped)', () => {
  const items = [
    item({ id: '1', total: 9000 }),
    item({ id: '2', total: null, rate: null, assumption_status: null }),
  ]
  const result = evaluateQualityGate({
    overall_confidence: 95,
    unresolved_count: 0,
    missing_trades: [],
    top_risks: [],
    total_cost: 9000,
    items,
  })
  assert.equal(result.state, 'blocked')
  assert.ok(result.blocked_reasons.some((r) => r.includes('could not be priced')))
  const unpriced = result.affected_line_items.find((i) => i.id === '2')
  assert.equal(unpriced?.reason, 'unpriced')
  // Not silently dropped from the total via exposure — it shows up as a
  // blocked reason instead, and never contributes a dollar figure to exposure.
  assert.equal(result.exposure.exposed_value, 0)
})

test('quality gate: an excluded item with rate=null is not flagged unpriced and contributes nothing', () => {
  const items = [
    item({ id: '1', total: 9000 }),
    item({ id: '2', total: null, rate: null, assumption_status: 'excluded' }),
  ]
  const result = evaluateQualityGate({
    overall_confidence: 95,
    unresolved_count: 0,
    missing_trades: [],
    top_risks: [],
    total_cost: 9000,
    items,
  })
  assert.equal(result.state, 'ready')
  assert.equal(result.affected_line_items.some((i) => i.id === '2'), false)
})

// ─── Exposure bucket math — no double-counting ──────────────────────────────

test('quality gate: exposure buckets are mutually exclusive and sum to exposed_value', () => {
  const items = [
    item({ id: '1', total: 2000, pricing_type: 'pc_allowance' }),
    item({ id: '2', total: 1500, pricing_type: 'provisional_sum' }),
    item({ id: '3', total: 500, is_assumption: true, assumption_status: 'unresolved' }),
    item({ id: '4', total: 700, is_assumption: true, assumption_status: 'accepted' }),
    item({ id: '5', total: 5300 }), // plain measured, no exposure
  ]
  const result = evaluateQualityGate({
    overall_confidence: 95,
    unresolved_count: 1,
    missing_trades: [],
    top_risks: [],
    total_cost: 10000,
    items,
  })
  const { exposure } = result
  assert.equal(exposure.pc_allowance_value, 2000)
  assert.equal(exposure.provisional_sum_value, 1500)
  assert.equal(exposure.unresolved_assumption_value, 500)
  assert.equal(exposure.resolved_assumption_value, 700)
  assert.equal(exposure.exposed_value, 2000 + 1500 + 500 + 700)
  assert.equal(exposure.exposed_pct, 47)
})

test('quality gate: PC/PS classification takes precedence over the assumption flag (no double bucket)', () => {
  const items = [
    item({ id: '1', total: 2000, pricing_type: 'provisional_sum', is_assumption: true, assumption_status: 'unresolved' }),
  ]
  const result = evaluateQualityGate({
    overall_confidence: 95,
    unresolved_count: 1,
    missing_trades: [],
    top_risks: [],
    total_cost: 2000,
    items,
  })
  assert.equal(result.exposure.provisional_sum_value, 2000)
  assert.equal(result.exposure.unresolved_assumption_value, 0)
  assert.equal(result.exposure.exposed_value, 2000) // not double-counted as 4000
})
