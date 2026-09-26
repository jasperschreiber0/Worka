import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCSV, parseAmount, parseDate, suggestMapping, mapCostRows } from './cost-import.ts'
const options = {
  taxBasis: 'exclusive' as const,
  labourBasis: 'included' as const,
  defaultDate: '2026-09-13',
  projectLabel: 'Test job',
}
test('CSV preserves commas, escaped quotes, embedded newlines and BOM', () => {
  assert.deepEqual(parseCSV('\uFEFFDescription,Amount\r\n"Frame, \"\"west\"\"\nwall","1,100.00"'), [
    ['Description', 'Amount'],
    ['Frame, "west"\nwall', '1,100.00'],
  ])
  assert.deepEqual(parseCSV('Description;Amount\na;100'), [
    ['Description', 'Amount'],
    ['a', '100'],
  ])
  assert.throws(() => parseCSV('"unclosed'))
})
test('invalid finance is rejected rather than coerced; dates follow Australian order', () => {
  assert.equal(parseAmount('$1,234.50'), 1234.5)
  assert.equal(parseAmount('(100.00)'), -100)
  assert.throws(() => parseAmount('abc'))
  assert.throws(() => parseAmount('1,2,3'))
  assert.throws(() => parseAmount('10,50'))
  assert.throws(() => parseAmount(''))
  assert.equal(parseDate('03/04/2026'), '2026-04-03')
  assert.throws(() => parseDate('31/02/2026'))
})
test('explicit GST conversion and labour addition are deterministic and retain source', () => {
  const mapping = suggestMapping(['Description', 'Amount', 'Labour cost', 'Labour hours', 'Trade'])
  assert.throws(() => mapCostRows([['Framing', '1100']], mapping, { ...options, taxBasis: '' }), /Confirm GST/)
  const a = mapCostRows([['Framing', '1100', '220', '4', 'framing']], mapping, {
    ...options,
    taxBasis: 'inclusive',
    labourBasis: 'additional',
  })[0]
  assert.equal(a.entry?.amount, 1200)
  assert.equal(a.entry?.labour_cost, 200)
  assert.equal(a.entry?.trade_category_id, 2)
  assert.equal(a.entry?.original_amount, 1100)
  assert.equal(
    mapCostRows([['Framing', '1100', '220', '4', 'framing']], mapping, {
      ...options,
      taxBasis: 'inclusive',
    })[0].entry?.amount,
    1000,
  )
})
test('mixed project, missing amounts and unpriced formulas block import', () => {
  const mapping = suggestMapping(['Description', 'Amount', 'Project'])
  for (const row of [
    ['Invoice', '200', 'Other job'],
    ['Frame', '', ''],
    ['Frame', '[FORMULA]', ''],
  ])
    assert.ok(mapCostRows([row], mapping, options)[0].error)
})
test('unclassified specialist costs are retained, never forced into a wrong estimate trade', () => {
  const mapping = suggestMapping(['Description', 'Amount', 'Trade'])
  const row = mapCostRows([['Window installation', '5000', 'windows']], mapping, options)[0]
  assert.equal(row.entry?.category, 'windows')
  assert.equal(row.entry?.trade_category_id, null)
  assert.equal(row.entry?.amount, 5000)
})
