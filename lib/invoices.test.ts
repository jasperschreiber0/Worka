import { test } from 'node:test'
import assert from 'node:assert/strict'
// Relative, .ts-suffixed import — same reason variations.test.ts/pricing.test.ts
// document: must resolve identically under plain `node --experimental-strip-types`
// and under Next.js/webpack.
import { computeInvoiceTotals, wouldExceedContractValue } from './invoices.ts'

test('computeInvoiceTotals: drafts are excluded from invoiced/paid/outstanding entirely', () => {
  const result = computeInvoiceTotals([{ id: '1', amount: 5000, status: 'draft' }])
  assert.deepEqual(result, { invoiced: 0, paid: 0, outstanding: 0 })
})

test('computeInvoiceTotals: a sent invoice counts toward invoiced and outstanding, not paid', () => {
  const result = computeInvoiceTotals([{ id: '1', amount: 5000, status: 'sent' }])
  assert.deepEqual(result, { invoiced: 5000, paid: 0, outstanding: 5000 })
})

test('computeInvoiceTotals: a paid invoice counts toward invoiced and paid, outstanding is 0', () => {
  const result = computeInvoiceTotals([{ id: '1', amount: 5000, status: 'paid' }])
  assert.deepEqual(result, { invoiced: 5000, paid: 5000, outstanding: 0 })
})

test('computeInvoiceTotals: overdue counts toward invoiced like sent, defensively (app never stores it)', () => {
  const result = computeInvoiceTotals([{ id: '1', amount: 5000, status: 'overdue' }])
  assert.deepEqual(result, { invoiced: 5000, paid: 0, outstanding: 5000 })
})

test('computeInvoiceTotals: multiple invoices sum correctly — the exact scenario from the milestone spec', () => {
  // Invoice A = $10,000 paid, Invoice B = $15,000 sent
  const result = computeInvoiceTotals([
    { id: 'a', amount: 10000, status: 'paid' },
    { id: 'b', amount: 15000, status: 'sent' },
  ])
  assert.deepEqual(result, { invoiced: 25000, paid: 10000, outstanding: 15000 })
})

test('computeInvoiceTotals: outstanding = invoiced - paid, not contract value - paid', () => {
  // A job could have 3 invoices sent/paid totalling less than the full
  // contract — the un-invoiced remainder must never appear as "outstanding".
  const result = computeInvoiceTotals([
    { id: 'a', amount: 20000, status: 'sent' },
    { id: 'b', amount: 5000, status: 'paid' },
  ])
  assert.equal(result.invoiced, 25000)
  assert.equal(result.outstanding, 20000)
})

test('computeInvoiceTotals: rounds to 2dp to avoid floating point drift', () => {
  const result = computeInvoiceTotals([
    { id: 'a', amount: 10.1, status: 'sent' },
    { id: 'b', amount: 10.2, status: 'paid' },
  ])
  assert.equal(result.invoiced, 20.3)
})

test('wouldExceedContractValue: a new invoice within remaining contract value is allowed', () => {
  const exceeds = wouldExceedContractValue([{ id: 'a', amount: 50000 }], 30000, 100000)
  assert.equal(exceeds, false)
})

test('wouldExceedContractValue: a new invoice pushing total over contract value is rejected', () => {
  const exceeds = wouldExceedContractValue([{ id: 'a', amount: 80000 }], 30000, 100000)
  assert.equal(exceeds, true)
})

test('wouldExceedContractValue: exact match to contract value is allowed (not strictly less-than)', () => {
  const exceeds = wouldExceedContractValue([{ id: 'a', amount: 70000 }], 30000, 100000)
  assert.equal(exceeds, false)
})

test('wouldExceedContractValue: excludeInvoiceId lets an edit re-check without double-counting itself', () => {
  const invoices = [
    { id: 'a', amount: 50000 },
    { id: 'b', amount: 20000 },
  ]
  // Editing invoice 'b' up to 50000: without exclusion this would look like
  // 50000 (a) + 20000 (b, stale) + 50000 (new b) = 120000 > 100000 — wrong.
  const exceeds = wouldExceedContractValue(invoices, 50000, 100000, 'b')
  assert.equal(exceeds, false)
})

test('wouldExceedContractValue: null contract value (no quote yet) never blocks', () => {
  const exceeds = wouldExceedContractValue([{ id: 'a', amount: 999999 }], 999999, null)
  assert.equal(exceeds, false)
})
