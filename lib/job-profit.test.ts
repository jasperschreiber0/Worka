import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateJobProfit } from './job-profit.ts'

const reconciled = { contract: 684000, approvedVariations: 31400, actual: 317800, outstandingCommitments: 181600, remaining: 92400, uncostedHours: 0, reconciled: true }
test('profit uses revised revenue and non-overlapping cost buckets', () => {
  const result = calculateJobProfit(reconciled)
  assert.equal(result.forecastCost, 591800)
  assert.equal(result.profit, 123600)
  assert.equal(result.margin, 17.28)
})
test('missing remaining allowance is not treated as confirmed zero', () => {
  assert.equal(calculateJobProfit({ ...reconciled, remaining: null }).profit, null)
  assert.equal(calculateJobProfit({ ...reconciled, remaining: 0 }).complete, true)
})
test('uncosted labour or unreconciled commitments block a complete forecast', () => {
  assert.equal(calculateJobProfit({ ...reconciled, uncostedHours: 8 }).forecastCost, null)
  assert.equal(calculateJobProfit({ ...reconciled, reconciled: false }).profit, null)
})
test('invalid values cannot enter profit calculations', () => {
  assert.throws(() => calculateJobProfit({ ...reconciled, actual: NaN }))
  assert.throws(() => calculateJobProfit({ ...reconciled, remaining: -1 }))
})
