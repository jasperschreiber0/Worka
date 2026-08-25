import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildVariationLineItemInsert, type ApprovedVariation } from './variations.ts'

function makeVariation(overrides: Partial<ApprovedVariation> = {}): ApprovedVariation {
  return {
    id: 'variation-1',
    job_id: 'job-1',
    title: 'Upgrade to stone benchtops',
    amount: 3200,
    trade_category_id: 8,
    ...overrides,
  }
}

test('buildVariationLineItemInsert: description is prefixed so it is recognisable in QuoteView, not a mystery line', () => {
  const insert = buildVariationLineItemInsert(makeVariation(), 'quote-1')
  assert.equal(insert.description, 'Variation: Upgrade to stone benchtops')
})

test('buildVariationLineItemInsert: total equals the variation amount unchanged — no markup, no GST arithmetic invented', () => {
  const insert = buildVariationLineItemInsert(makeVariation({ amount: 3200.456 }), 'quote-1')
  // round2 only — never a margin multiplication, never a GST division.
  assert.equal(insert.total, 3200.46)
})

test('buildVariationLineItemInsert: margin_pct is 0 so calculateClientPrice() passes the amount straight through unmarked-up', () => {
  const insert = buildVariationLineItemInsert(makeVariation(), 'quote-1')
  assert.equal(insert.margin_pct, 0)
})

test('buildVariationLineItemInsert: quantity/unit/rate are null — a lump-sum line, same shape as an existing PC/PS allowance', () => {
  const insert = buildVariationLineItemInsert(makeVariation(), 'quote-1')
  assert.equal(insert.quantity, null)
  assert.equal(insert.unit, null)
  assert.equal(insert.rate, null)
})

test('buildVariationLineItemInsert: carries the variation_id back-reference and the variation pricing_source/provenance tags', () => {
  const insert = buildVariationLineItemInsert(makeVariation({ id: 'variation-42' }), 'quote-1')
  assert.equal(insert.variation_id, 'variation-42')
  assert.equal(insert.pricing_source, 'variation')
  assert.equal(insert.predicted_by, 'human')
  assert.equal(insert.confidence, 100)
  assert.equal(insert.is_assumption, false)
  assert.equal(insert.assumption_status, null)
  assert.equal(insert.pricing_basis, null)
})

test('buildVariationLineItemInsert: carries the given quote_id and trade_category_id through unchanged', () => {
  const insert = buildVariationLineItemInsert(makeVariation({ trade_category_id: 12 }), 'quote-99')
  assert.equal(insert.quote_id, 'quote-99')
  assert.equal(insert.trade_category_id, 12)
})

test('buildVariationLineItemInsert: throws when trade_category_id is null — callers must check first, never silently default a trade', () => {
  assert.throws(() => buildVariationLineItemInsert(makeVariation({ trade_category_id: null }), 'quote-1'))
})
