import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateConstructionCoverage, type ConstructionSanityLineItem } from './construction-sanity.ts'

function item(overrides: Partial<ConstructionSanityLineItem> = {}): ConstructionSanityLineItem {
  return {
    trade_category_id: 1,
    description: 'Item',
    quantity: 1,
    unit: 'each',
    assumption_status: null,
    ...overrides,
  }
}

test('extension with electrical-only scope flags missing structural trades — the $132k failure shape', () => {
  const result = evaluateConstructionCoverage({
    lineItems: [
      item({ trade_category_id: 12, description: 'GPOs and switches for extension', quantity: 10, unit: 'each' }),
      item({ trade_category_id: 11, description: 'Bathroom fixtures for extension', quantity: 2, unit: 'each' }),
    ],
    scopeItems: [],
  })
  const finding = result.findings.find((f) => f.id === 'coverage_structural_trades_absent')
  assert.ok(finding, 'expected coverage_structural_trades_absent finding')
  assert.equal(finding?.severity, 'red')
  assert.deepEqual(result.missing_trade_ids.sort(), [2, 3, 4])
})

test('extension WITH framing/roofing/cladding present does not flag structural absence', () => {
  const result = evaluateConstructionCoverage({
    lineItems: [
      item({ trade_category_id: 2, description: 'Framing for extension', quantity: 40, unit: 'lm' }),
      item({ trade_category_id: 3, description: 'Roofing for extension', quantity: 60, unit: 'm2' }),
      item({ trade_category_id: 4, description: 'Cladding for extension', quantity: 50, unit: 'm2' }),
      item({ trade_category_id: 12, description: 'Electrical for extension', quantity: 10, unit: 'each' }),
    ],
    scopeItems: [],
  })
  assert.equal(result.findings.find((f) => f.id === 'coverage_structural_trades_absent'), undefined)
})

test('a project with no extension/renovation/new-build characteristics never fires the structural check', () => {
  const result = evaluateConstructionCoverage({
    lineItems: [item({ trade_category_id: 10, description: 'Replace bathroom floor tiles', quantity: 8, unit: 'm2' })],
    scopeItems: [],
  })
  assert.equal(result.findings.length, 0)
  assert.deepEqual(result.detected_characteristics, [])
})

test('demolition mentioned with no Site Works trade at all flags amber', () => {
  const result = evaluateConstructionCoverage({
    lineItems: [
      item({ trade_category_id: 2, description: 'Demolition of existing structure noted in facts', quantity: 1, unit: 'lot' }),
      item({ trade_category_id: 12, description: 'Electrical rewire', quantity: 5, unit: 'each' }),
    ],
    scopeItems: [],
  })
  assert.ok(result.findings.find((f) => f.id === 'coverage_demolition_without_site_works'))
})

test('high-value project with few trades flags narrow coverage even without a characteristic keyword', () => {
  const result = evaluateConstructionCoverage({
    lineItems: [
      item({ trade_category_id: 12, description: 'Electrical works', quantity: 20, unit: 'each' }),
      item({ trade_category_id: 11, description: 'Plumbing fixtures', quantity: 5, unit: 'each' }),
    ],
    scopeItems: [],
    totalCost: 800_000,
  })
  assert.ok(result.findings.find((f) => f.id === 'coverage_unusually_narrow'))
})

test('a genuinely small project (no characteristics, low value) never fires the narrow-coverage check', () => {
  const result = evaluateConstructionCoverage({
    lineItems: [
      item({ trade_category_id: 10, description: 'New floor tiles', quantity: 8, unit: 'm2' }),
      item({ trade_category_id: 9, description: 'Paint bathroom', quantity: 20, unit: 'm2' }),
    ],
    scopeItems: [],
    totalCost: 15_000,
  })
  assert.equal(result.findings.length, 0)
})

test('characteristics detected from project_facts text even when no line item restates them', () => {
  // The exact gap forensic validation found: a narrow scope whose own
  // generated line items never happen to say "extension"/"second storey"
  // must still be checked against what the project's own facts establish.
  const result = evaluateConstructionCoverage({
    lineItems: [
      item({ trade_category_id: 12, description: 'GPOs, downlights and switches', quantity: 20, unit: 'each' }),
      item({ trade_category_id: 11, description: 'Bathroom fixtures', quantity: 3, unit: 'each' }),
    ],
    scopeItems: [],
    projectFactsText: 'Alterations and Additions second storey addition existing double storey dwelling',
  })
  assert.ok(result.detected_characteristics.includes('second_storey'))
  assert.ok(result.findings.find((f) => f.id === 'coverage_structural_trades_absent'))
})

test('expected/detected counts are reported even when nothing is wrong', () => {
  const result = evaluateConstructionCoverage({
    lineItems: [
      item({ trade_category_id: 1, description: 'Site works' }),
      item({ trade_category_id: 2, description: 'Framing' }),
      item({ trade_category_id: 3, description: 'Roofing' }),
    ],
    scopeItems: [],
  })
  assert.equal(result.detected_trade_count, 3)
  assert.equal(typeof result.expected_trade_count, 'number')
})
