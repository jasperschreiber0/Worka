import { test } from 'node:test'
import assert from 'node:assert/strict'
// Relative, .ts-suffixed import — same reason invoices.test.ts/variations.test.ts
// document: must resolve identically under plain `node --experimental-strip-types`
// and under Next.js/webpack.
import { buildReconciliationEntries } from './job-closeout.ts'

test('buildReconciliationEntries: one entry per quote trade, actual_cost summed from matching cost rows', () => {
  const trades = [
    { trade_category_id: 3, estimated_cost: 10000 },
    { trade_category_id: 7, estimated_cost: 5000 },
  ]
  const costRows = [
    { trade_category_id: 3, amount: 4000 },
    { trade_category_id: 3, amount: 2500 },
    { trade_category_id: 7, amount: 5200 },
  ]
  const result = buildReconciliationEntries(trades, costRows)
  assert.deepEqual(result.entries, [
    { trade_category_id: 3, estimated_cost: 10000, actual_cost: 6500 },
    { trade_category_id: 7, estimated_cost: 5000, actual_cost: 5200 },
  ])
  assert.equal(result.unclassifiedCostTotal, 0)
  assert.equal(result.unclassifiedCostCount, 0)
})

test('buildReconciliationEntries: a trade with no logged cost rows gets actual_cost null, not 0 or omitted', () => {
  const trades = [
    { trade_category_id: 3, estimated_cost: 10000 },
    { trade_category_id: 7, estimated_cost: 5000 },
  ]
  const costRows = [{ trade_category_id: 3, amount: 4000 }]
  const result = buildReconciliationEntries(trades, costRows)
  assert.equal(result.entries.length, 2)
  assert.equal(result.entries[0].actual_cost, 4000)
  assert.equal(result.entries[1].trade_category_id, 7)
  assert.equal(result.entries[1].actual_cost, null)
})

test('buildReconciliationEntries: cost rows with no trade_category_id are excluded from entries, never invented onto a trade', () => {
  const trades = [{ trade_category_id: 3, estimated_cost: 10000 }]
  const costRows = [
    { trade_category_id: 3, amount: 4000 },
    { trade_category_id: null, amount: 850 }, // e.g. a council permit fee
    { trade_category_id: null, amount: 150 }, // e.g. a skip bin hire
  ]
  const result = buildReconciliationEntries(trades, costRows)
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].actual_cost, 4000)
  assert.equal(result.unclassifiedCostTotal, 1000)
  assert.equal(result.unclassifiedCostCount, 2)
})

test('buildReconciliationEntries: no trades on the quote produces an empty entries array (caller must handle — reconcile requires a non-empty array)', () => {
  const result = buildReconciliationEntries([], [{ trade_category_id: 3, amount: 500 }])
  assert.deepEqual(result.entries, [])
})

test('buildReconciliationEntries: no cost rows at all logged — every trade gets actual_cost null', () => {
  const trades = [
    { trade_category_id: 3, estimated_cost: 10000 },
    { trade_category_id: 7, estimated_cost: 5000 },
  ]
  const result = buildReconciliationEntries(trades, [])
  assert.deepEqual(result.entries, [
    { trade_category_id: 3, estimated_cost: 10000, actual_cost: null },
    { trade_category_id: 7, estimated_cost: 5000, actual_cost: null },
  ])
  assert.equal(result.unclassifiedCostTotal, 0)
})

test('buildReconciliationEntries: rounds summed actual_cost to 2dp against floating-point drift', () => {
  const trades = [{ trade_category_id: 3, estimated_cost: 100 }]
  const costRows = [
    { trade_category_id: 3, amount: 0.1 },
    { trade_category_id: 3, amount: 0.2 },
  ]
  const result = buildReconciliationEntries(trades, costRows)
  assert.equal(result.entries[0].actual_cost, 0.3)
})
