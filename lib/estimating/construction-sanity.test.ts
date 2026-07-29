import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateConstructionSanity, type ConstructionSanityLineItem, type ConstructionSanityScopeItem } from './construction-sanity.ts'

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

function scope(overrides: Partial<ConstructionSanityScopeItem> = {}): ConstructionSanityScopeItem {
  return {
    trade_category_id: 1,
    included_scope: [],
    dependencies: [],
    assumptions: [],
    ...overrides,
  }
}

test('no findings on an empty context', () => {
  const findings = evaluateConstructionSanity({ lineItems: [], scopeItems: [] })
  assert.equal(findings.length, 0)
})

test('paint vs cladding: flags when paint area far exceeds cladding area', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 9, description: 'External paint to extension', quantity: 400, unit: 'm2' }),
      item({ trade_category_id: 4, description: 'Weatherboard cladding', quantity: 63, unit: 'm2' }),
    ],
    scopeItems: [],
  })
  const finding = findings.find((f) => f.id === 'paint_vs_cladding_area')
  assert.ok(finding, 'expected paint_vs_cladding_area finding')
  assert.equal(finding?.severity, 'amber')
})

test('paint vs cladding: no finding when paint area is plausible', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 9, description: 'External paint to extension', quantity: 65, unit: 'm2' }),
      item({ trade_category_id: 4, description: 'Weatherboard cladding', quantity: 63, unit: 'm2' }),
    ],
    scopeItems: [],
  })
  assert.equal(findings.find((f) => f.id === 'paint_vs_cladding_area'), undefined)
})

test('paint vs cladding: excluded line items are not counted', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 9, description: 'External paint to extension', quantity: 400, unit: 'm2', assumption_status: 'excluded' }),
      item({ trade_category_id: 4, description: 'Weatherboard cladding', quantity: 63, unit: 'm2' }),
    ],
    scopeItems: [],
  })
  assert.equal(findings.find((f) => f.id === 'paint_vs_cladding_area'), undefined)
})

test('framing vs footprint: flags underestimated wall framing', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 2, description: 'Wall framing to extension', quantity: 10, unit: 'lm' }),
      item({ trade_category_id: 1, description: 'Concrete slab on ground to extension', quantity: 55, unit: 'm2' }),
    ],
    scopeItems: [],
  })
  const finding = findings.find((f) => f.id === 'framing_vs_footprint')
  assert.ok(finding, 'expected framing_vs_footprint finding')
})

test('framing vs footprint: no finding when framing is plausible', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 2, description: 'Wall framing to extension', quantity: 30, unit: 'lm' }),
      item({ trade_category_id: 1, description: 'Concrete slab on ground to extension', quantity: 55, unit: 'm2' }),
    ],
    scopeItems: [],
  })
  assert.equal(findings.find((f) => f.id === 'framing_vs_footprint'), undefined)
})

test('kitchen completeness: flags cabinetry with no benchtop/splashback', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [item({ trade_category_id: 8, description: 'Kitchen cabinetry — base and overhead', quantity: 6.5, unit: 'lm' })],
    scopeItems: [],
  })
  const finding = findings.find((f) => f.id === 'kitchen_completeness')
  assert.ok(finding, 'expected kitchen_completeness finding')
  assert.equal(finding?.severity, 'red')
})

test('kitchen completeness: no finding when benchtop exists', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 8, description: 'Kitchen cabinetry — base and overhead', quantity: 6.5, unit: 'lm' }),
      item({ trade_category_id: 8, description: 'Stone benchtop', quantity: 6.5, unit: 'lm' }),
    ],
    scopeItems: [],
  })
  assert.equal(findings.find((f) => f.id === 'kitchen_completeness'), undefined)
})

test('kitchen completeness: no finding when no kitchen is scoped at all', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [item({ trade_category_id: 8, description: 'Bathroom vanity', quantity: 1, unit: 'each' })],
    scopeItems: [],
  })
  assert.equal(findings.find((f) => f.id === 'kitchen_completeness'), undefined)
})

test('bathroom completeness: missing waterproofing is red and takes priority over the secondary checklist', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [item({ trade_category_id: 6, description: 'Wet area lining villaboard — ensuite', quantity: 18, unit: 'm2' })],
    scopeItems: [],
  })
  const finding = findings.find((f) => f.id === 'bathroom_completeness')
  assert.ok(finding, 'expected bathroom_completeness finding')
  assert.equal(finding?.severity, 'red')
  assert.match(finding!.what_noticed, /waterproofing/i)
})

test('bathroom completeness: secondary checklist fires once waterproofing exists', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 6, description: 'Waterproofing membrane — ensuite', quantity: 18, unit: 'm2' }),
    ],
    scopeItems: [],
  })
  const finding = findings.find((f) => f.id === 'bathroom_completeness')
  assert.ok(finding, 'expected bathroom_completeness finding')
  assert.equal(finding?.severity, 'amber')
  assert.match(finding!.what_noticed, /tiling/i)
})

test('bathroom completeness: no finding when the checklist is satisfied', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 6, description: 'Waterproofing membrane — ensuite', quantity: 18, unit: 'm2' }),
      item({ trade_category_id: 10, description: 'Floor tiles — ensuite', quantity: 6, unit: 'm2' }),
      item({ trade_category_id: 11, description: 'Fixtures and tapware — ensuite', quantity: 4, unit: 'each' }),
      item({ trade_category_id: 6, description: 'Exhaust fan — ensuite', quantity: 1, unit: 'each' }),
    ],
    scopeItems: [],
  })
  assert.equal(findings.find((f) => f.id === 'bathroom_completeness'), undefined)
})

test('bathroom completeness: detected from scope text even with no matching line item description', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [item({ trade_category_id: 1, description: 'Excavation', quantity: 10, unit: 'm3' })],
    scopeItems: [scope({ trade_category_id: 6, included_scope: ['Ensuite renovation including wall and floor finishes'] })],
  })
  assert.ok(findings.find((f) => f.id === 'bathroom_completeness'))
})

test('extension structural dependency: flags an extension with no engineering line', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [item({ trade_category_id: 1, description: 'Excavation and earthworks for extension footprint', quantity: 22, unit: 'm3' })],
    scopeItems: [],
  })
  const finding = findings.find((f) => f.id === 'extension_structural_dependency')
  assert.ok(finding, 'expected extension_structural_dependency finding')
  assert.equal(finding?.severity, 'amber')
})

test('extension structural dependency: no finding when engineering is present', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 1, description: 'Excavation and earthworks for extension footprint', quantity: 22, unit: 'm3' }),
      item({ trade_category_id: 13, description: 'Structural engineer fees', quantity: 1, unit: 'lot' }),
    ],
    scopeItems: [],
  })
  assert.equal(findings.find((f) => f.id === 'extension_structural_dependency'), undefined)
})

test('findings are sorted red before amber', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      // amber: extension with no engineering
      item({ trade_category_id: 1, description: 'Excavation and earthworks for extension footprint', quantity: 22, unit: 'm3' }),
      // red: kitchen with no benchtop
      item({ trade_category_id: 8, description: 'Kitchen cabinetry — base and overhead', quantity: 6.5, unit: 'lm' }),
    ],
    scopeItems: [],
  })
  assert.ok(findings.length >= 2)
  const firstRedIndex = findings.findIndex((f) => f.severity === 'red')
  const firstAmberIndex = findings.findIndex((f) => f.severity === 'amber')
  assert.ok(firstRedIndex < firstAmberIndex)
})

test('a rule that throws does not take down evaluation of the others', () => {
  // quantity as a non-number would break naive arithmetic if a rule didn't
  // guard for it — confirms evaluateConstructionSanity's per-rule try/catch
  // keeps the other rules running regardless.
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 8, description: 'Kitchen cabinetry — base and overhead', quantity: 6.5, unit: 'lm' }),
      item({ trade_category_id: 9, description: 'External paint to extension', quantity: Number.NaN, unit: 'm2' }),
      item({ trade_category_id: 4, description: 'Weatherboard cladding', quantity: 63, unit: 'm2' }),
    ],
    scopeItems: [],
  })
  assert.ok(findings.find((f) => f.id === 'kitchen_completeness'))
})
