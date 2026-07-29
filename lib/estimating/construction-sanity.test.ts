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

test('lump decomposition overlap: flags a lump alongside its own decomposed siblings', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 13, description: 'Landscaping and driveway', quantity: 1, unit: 'lot' }),
      item({ trade_category_id: 13, description: 'Landscaping — planting and turf', quantity: 1, unit: 'lot' }),
      item({ trade_category_id: 1, description: 'Driveway construction — 2-car space', quantity: 36, unit: 'm2' }),
    ],
    scopeItems: [],
  })
  const finding = findings.find((f) => f.id === 'lump_decomposition_overlap')
  assert.ok(finding, 'expected lump_decomposition_overlap finding')
  assert.equal(finding?.severity, 'red')
})

test('lump decomposition overlap: does not false-positive on unrelated items sharing a word', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 1, description: 'Piers and footings — waffle pod slab edge beams', quantity: 1, unit: 'lot' }),
      item({ trade_category_id: 1, description: 'Excavation for new footings, piers and pool', quantity: 180, unit: 'm3' }),
    ],
    scopeItems: [],
  })
  assert.equal(findings.find((f) => f.id === 'lump_decomposition_overlap'), undefined)
})

test('lump decomposition overlap: no finding when nothing else in the quote overlaps', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 13, description: 'Permits and certifier fees', quantity: 1, unit: 'lot' }),
      item({ trade_category_id: 13, description: 'Structural engineering fees', quantity: 1, unit: 'lot' }),
    ],
    scopeItems: [],
  })
  assert.equal(findings.find((f) => f.id === 'lump_decomposition_overlap'), undefined)
})

test('document price overridden: flags an item priced via a lower tier despite a matching confirmed selection', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 8, description: 'Toto Neorest smart toilet suite — ensuite', quantity: 1, unit: 'each', pricing_source: 'ai_measured_rate', total: 650 }),
    ],
    scopeItems: [],
    documentSelections: [
      { fact_id: 'f1', category: 'fixtures', key: 'toilet', value: 'Toto Neorest smart toilet suite, ensuite, $8,500', confidence: 90, source_document_id: 'doc1', created_at: '2026-07-01T00:00:00Z' },
    ],
  })
  const finding = findings.find((f) => f.id === 'document_price_overridden')
  assert.ok(finding, 'expected document_price_overridden finding')
  assert.equal(finding?.severity, 'red')
})

test('document price overridden: no finding when the item already used the document selection', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 8, description: 'Toto Neorest smart toilet suite — ensuite', quantity: 1, unit: 'each', pricing_source: 'document_selection', total: 8500 }),
    ],
    scopeItems: [],
    documentSelections: [
      { fact_id: 'f1', category: 'fixtures', key: 'toilet', value: 'Toto Neorest smart toilet suite, ensuite, $8,500', confidence: 90, source_document_id: 'doc1', created_at: '2026-07-01T00:00:00Z' },
    ],
  })
  assert.equal(findings.find((f) => f.id === 'document_price_overridden'), undefined)
})

test('document price overridden: no finding when no document selections were supplied', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 8, description: 'Toto Neorest smart toilet suite — ensuite', quantity: 1, unit: 'each', pricing_source: 'ai_measured_rate', total: 650 }),
    ],
    scopeItems: [],
  })
  assert.equal(findings.find((f) => f.id === 'document_price_overridden'), undefined)
})

test('high value AI allowance: flags an item over the threshold priced by AI', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 7, description: 'Residential lift — supply and installation', quantity: 1, unit: 'each', pricing_source: 'ai_measured_rate', total: 78000 }),
    ],
    scopeItems: [],
  })
  const finding = findings.find((f) => f.id === 'high_value_ai_allowance')
  assert.ok(finding, 'expected high_value_ai_allowance finding')
  assert.equal(finding?.severity, 'amber')
})

test('high value AI allowance: no finding under the threshold', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 7, description: 'Residential lift — supply and installation', quantity: 1, unit: 'each', pricing_source: 'ai_measured_rate', total: 12000 }),
    ],
    scopeItems: [],
  })
  assert.equal(findings.find((f) => f.id === 'high_value_ai_allowance'), undefined)
})

test('high value AI allowance: no finding when priced from a market rate instead', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 7, description: 'Residential lift — supply and installation', quantity: 1, unit: 'each', pricing_source: 'cost_rates_exact', total: 78000 }),
    ],
    scopeItems: [],
  })
  assert.equal(findings.find((f) => f.id === 'high_value_ai_allowance'), undefined)
})

test('trade has no market rate coverage: flags a trade entirely priced via AI/category/unresolved', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 7, description: 'Residential lift — supply and installation', quantity: 1, unit: 'each', pricing_source: 'ai_measured_rate', total: 78000 }),
      item({ trade_category_id: 7, description: 'Lift shaft internal finishes', quantity: 1, unit: 'lot', pricing_source: 'category_rate', total: 4500 }),
    ],
    scopeItems: [],
  })
  const finding = findings.find((f) => f.id === 'trade_has_no_market_rate_coverage')
  assert.ok(finding, 'expected trade_has_no_market_rate_coverage finding')
  assert.equal(finding?.severity, 'amber')
})

test('trade has no market rate coverage: no finding when at least one item in the trade has real coverage', () => {
  const findings = evaluateConstructionSanity({
    lineItems: [
      item({ trade_category_id: 7, description: 'Residential lift — supply and installation', quantity: 1, unit: 'each', pricing_source: 'ai_measured_rate', total: 78000 }),
      item({ trade_category_id: 7, description: 'External doors', quantity: 13, unit: 'each', pricing_source: 'cost_rates_exact', total: 6006 }),
    ],
    scopeItems: [],
  })
  assert.equal(findings.find((f) => f.id === 'trade_has_no_market_rate_coverage'), undefined)
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
