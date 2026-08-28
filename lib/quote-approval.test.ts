import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isQuoteApprovableByClient,
  isQuoteViewableByClient,
  describeQuoteApprovalState,
  buildClientVisibleQuote,
  type QuoteLineItemForClient,
} from './quote-approval.ts'

// ─── State-transition / eligibility rules ──────────────────────────────────

test('isQuoteApprovableByClient: only "sent" is approvable', () => {
  assert.equal(isQuoteApprovableByClient('sent'), true)
  assert.equal(isQuoteApprovableByClient('draft'), false)
  assert.equal(isQuoteApprovableByClient('pending_review'), false)
  assert.equal(isQuoteApprovableByClient('approved'), false)
  assert.equal(isQuoteApprovableByClient('rejected'), false)
})

test('isQuoteViewableByClient: sent, approved, and rejected are viewable; draft/pending_review are not', () => {
  assert.equal(isQuoteViewableByClient('sent'), true)
  assert.equal(isQuoteViewableByClient('approved'), true)
  assert.equal(isQuoteViewableByClient('rejected'), true)
  assert.equal(isQuoteViewableByClient('draft'), false)
  assert.equal(isQuoteViewableByClient('pending_review'), false)
})

test('describeQuoteApprovalState: maps status to the correct outcome', () => {
  assert.equal(describeQuoteApprovalState('approved'), 'approved')
  assert.equal(describeQuoteApprovalState('rejected'), 'rejected')
  assert.equal(describeQuoteApprovalState('sent'), 'not_yet_decided')
  assert.equal(describeQuoteApprovalState('draft'), 'not_yet_decided')
  assert.equal(describeQuoteApprovalState('pending_review'), 'not_yet_decided')
})

// ─── Client-safe line item view ────────────────────────────────────────────

test('buildClientVisibleQuote: applies margin to produce the marked-up client price, never raw cost', () => {
  const items: QuoteLineItemForClient[] = [
    { trade_category_id: 1, description: 'Demolition', total: 1000, margin_pct: 0.18, assumption_status: 'resolved' },
  ]
  const result = buildClientVisibleQuote(items)
  assert.equal(result.categories.length, 1)
  assert.equal(result.categories[0].items[0].client_price, 1180)
  assert.equal(result.categories[0].subtotal, 1180)
  assert.equal(result.total, 1180)
})

test('buildClientVisibleQuote: excludes items with assumption_status "excluded" from items, subtotals, and total', () => {
  const items: QuoteLineItemForClient[] = [
    { trade_category_id: 1, description: 'Included item', total: 1000, margin_pct: 0.2, assumption_status: 'resolved' },
    { trade_category_id: 1, description: 'Excluded item', total: 5000, margin_pct: 0.2, assumption_status: 'excluded' },
  ]
  const result = buildClientVisibleQuote(items)
  assert.equal(result.categories.length, 1)
  assert.equal(result.categories[0].items.length, 1)
  assert.equal(result.categories[0].items[0].description, 'Included item')
  assert.equal(result.categories[0].subtotal, 1200)
  assert.equal(result.total, 1200)
})

test('buildClientVisibleQuote: groups items by trade category and sorts categories ascending by trade_category_id', () => {
  const items: QuoteLineItemForClient[] = [
    { trade_category_id: 5, description: 'Electrical rough-in', total: 2000, margin_pct: 0.18, assumption_status: 'resolved' },
    { trade_category_id: 1, description: 'Demolition', total: 1000, margin_pct: 0.18, assumption_status: 'resolved' },
    { trade_category_id: 1, description: 'Site prep', total: 500, margin_pct: 0.18, assumption_status: 'resolved' },
  ]
  const result = buildClientVisibleQuote(items)
  assert.equal(result.categories.length, 2)
  assert.equal(result.categories[0].trade_category_id, 1)
  assert.equal(result.categories[0].items.length, 2)
  assert.equal(result.categories[1].trade_category_id, 5)
  assert.equal(result.categories[1].items.length, 1)
})

test('buildClientVisibleQuote: total sums correctly across multiple categories', () => {
  const items: QuoteLineItemForClient[] = [
    { trade_category_id: 1, description: 'A', total: 1000, margin_pct: 0.18, assumption_status: 'resolved' },
    { trade_category_id: 2, description: 'B', total: 2000, margin_pct: 0.18, assumption_status: 'resolved' },
  ]
  const result = buildClientVisibleQuote(items)
  assert.equal(result.total, 1180 + 2360)
})

test('buildClientVisibleQuote: never leaks internal-only fields (total, margin_pct, assumption_status) into the returned shape', () => {
  const items: QuoteLineItemForClient[] = [
    { trade_category_id: 1, description: 'Demolition', total: 1000, margin_pct: 0.18, assumption_status: 'resolved' },
  ]
  const result = buildClientVisibleQuote(items)
  const item = result.categories[0].items[0] as unknown as Record<string, unknown>
  assert.equal('total' in item, false)
  assert.equal('margin_pct' in item, false)
  assert.equal('assumption_status' in item, false)
  assert.deepEqual(Object.keys(item).sort(), ['client_price', 'description'])
})

test('buildClientVisibleQuote: empty input produces zero categories and zero total', () => {
  const result = buildClientVisibleQuote([])
  assert.deepEqual(result.categories, [])
  assert.equal(result.total, 0)
})

test('buildClientVisibleQuote: a null margin_pct defaults to 0% markup (raw cost passed through unmarked-up)', () => {
  const items: QuoteLineItemForClient[] = [
    { trade_category_id: 1, description: 'Provisional sum item', total: 1000, margin_pct: null, assumption_status: 'resolved' },
  ]
  const result = buildClientVisibleQuote(items)
  assert.equal(result.categories[0].items[0].client_price, 1000)
})
