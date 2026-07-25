import { test } from 'node:test'
import assert from 'node:assert/strict'
// Relative .ts import — same reason lib/pricing.test.ts documents: must
// resolve identically under plain `node --experimental-strip-types` and
// under Next.js/webpack.
import {
  classifyUnresolvedItem,
  classifyUnresolvedItems,
  hasEnoughInformationToPrice,
  buildUnresolvedDiagnosticsReport,
  type UnresolvedItemInput,
} from './unresolved-diagnostics.ts'

function item(overrides: Partial<UnresolvedItemInput> = {}): UnresolvedItemInput {
  return {
    id: 'li-1', description: 'Test item', trade_category_id: 1,
    quantity: null, unit: null, pricing_type: 'measured', gate: 1, gate_message: null,
    ...overrides,
  }
}

// ─── Category A: measured pricing failure ──────────────────────────────────

test('classifyUnresolvedItem: a quantity+unit item is measured_pricing_failure — "36m2 concrete slab"', () => {
  const category = classifyUnresolvedItem({ quantity: 36, unit: 'm2', pricing_type: 'measured' })
  assert.equal(category, 'measured_pricing_failure')
})

test('classifyUnresolvedItem: "3.45lm kitchen joinery" — decimal quantity still counts as measured', () => {
  const category = classifyUnresolvedItem({ quantity: 3.45, unit: 'lm', pricing_type: 'measured' })
  assert.equal(category, 'measured_pricing_failure')
})

test('classifyUnresolvedItem: quantity+unit wins even if pricing_type happens to be pc_allowance', () => {
  // A measurable quantity is decisive regardless of pricing_type — this is
  // real scope Stage 6 measured, so pricing (not understanding) is what failed.
  const category = classifyUnresolvedItem({ quantity: 12, unit: 'each', pricing_type: 'pc_allowance' })
  assert.equal(category, 'measured_pricing_failure')
})

// ─── Category B: allowance candidate ───────────────────────────────────────

test('classifyUnresolvedItem: no quantity/unit but pc_allowance pricing_type — "specialist equipment"', () => {
  const category = classifyUnresolvedItem({ quantity: null, unit: null, pricing_type: 'pc_allowance' })
  assert.equal(category, 'allowance_candidate')
})

test('classifyUnresolvedItem: provisional_sum with no quantity/unit — "complex installations"', () => {
  const category = classifyUnresolvedItem({ quantity: null, unit: null, pricing_type: 'provisional_sum' })
  assert.equal(category, 'allowance_candidate')
})

test('classifyUnresolvedItem: quantity present but unit missing, pc_allowance — still allowance_candidate (not measured, since unit is required too)', () => {
  const category = classifyUnresolvedItem({ quantity: 1, unit: null, pricing_type: 'pc_allowance' })
  assert.equal(category, 'allowance_candidate')
})

// ─── Category C: true unresolved ───────────────────────────────────────────

test('classifyUnresolvedItem: no quantity/unit and pricing_type measured — genuinely insufficient information', () => {
  const category = classifyUnresolvedItem({ quantity: null, unit: null, pricing_type: 'measured' })
  assert.equal(category, 'true_unresolved')
})

test('classifyUnresolvedItem: empty-string unit is treated the same as a missing unit', () => {
  const category = classifyUnresolvedItem({ quantity: null, unit: '', pricing_type: 'measured' })
  assert.equal(category, 'true_unresolved')
})

test('classifyUnresolvedItem: null pricing_type with no quantity/unit falls to true_unresolved, not allowance_candidate', () => {
  const category = classifyUnresolvedItem({ quantity: null, unit: null, pricing_type: null })
  assert.equal(category, 'true_unresolved')
})

// ─── hasEnoughInformationToPrice ────────────────────────────────────────────

test('hasEnoughInformationToPrice: true for measured_pricing_failure and allowance_candidate, false only for true_unresolved', () => {
  assert.equal(hasEnoughInformationToPrice('measured_pricing_failure'), true)
  assert.equal(hasEnoughInformationToPrice('allowance_candidate'), true)
  assert.equal(hasEnoughInformationToPrice('true_unresolved'), false)
})

// ─── classifyUnresolvedItems (batch) ────────────────────────────────────────

test('classifyUnresolvedItems: attaches category and has_enough_information without mutating input fields', () => {
  const items = [
    item({ id: 'a', quantity: 36, unit: 'm2' }),
    item({ id: 'b', quantity: null, unit: null, pricing_type: 'pc_allowance' }),
    item({ id: 'c', quantity: null, unit: null, pricing_type: 'measured' }),
  ]
  const classified = classifyUnresolvedItems(items)
  assert.deepEqual(classified.map((i) => [i.id, i.category, i.has_enough_information]), [
    ['a', 'measured_pricing_failure', true],
    ['b', 'allowance_candidate', true],
    ['c', 'true_unresolved', false],
  ])
  // original fields preserved
  assert.equal(classified[0].description, 'Test item')
  assert.equal(classified[0].trade_category_id, 1)
})

// ─── buildUnresolvedDiagnosticsReport ──────────────────────────────────────

test('buildUnresolvedDiagnosticsReport: groups by category with correct counts and total', () => {
  const classified = classifyUnresolvedItems([
    item({ id: 'a', quantity: 36, unit: 'm2' }),
    item({ id: 'b', quantity: 3.45, unit: 'lm' }),
    item({ id: 'c', quantity: null, unit: null, pricing_type: 'pc_allowance' }),
    item({ id: 'd', quantity: null, unit: null, pricing_type: 'measured' }),
  ])
  const report = buildUnresolvedDiagnosticsReport(classified)
  assert.equal(report.total_items, 4)
  const byCategory = Object.fromEntries(report.categories.map((c) => [c.category, c]))
  assert.equal(byCategory.measured_pricing_failure.item_count, 2)
  assert.equal(byCategory.allowance_candidate.item_count, 1)
  assert.equal(byCategory.true_unresolved.item_count, 1)
})

test('buildUnresolvedDiagnosticsReport: current_value_impact is always 0 — never fabricates a dollar figure for unpriced items', () => {
  const classified = classifyUnresolvedItems([item({ id: 'a', quantity: 36, unit: 'm2' })])
  const report = buildUnresolvedDiagnosticsReport(classified)
  for (const c of report.categories) {
    assert.equal(c.current_value_impact, 0)
  }
})

test('buildUnresolvedDiagnosticsReport: every category has a non-empty recommended_next_action, even with zero items', () => {
  const report = buildUnresolvedDiagnosticsReport([])
  assert.equal(report.total_items, 0)
  for (const c of report.categories) {
    assert.equal(c.item_count, 0)
    assert.ok(c.recommended_next_action.length > 0)
    assert.deepEqual(c.examples, [])
  }
})

test('buildUnresolvedDiagnosticsReport: examples cap at 5 per category even with more items', () => {
  const classified = classifyUnresolvedItems(
    Array.from({ length: 8 }, (_, i) => item({ id: `m-${i}`, quantity: 10, unit: 'm2' }))
  )
  const report = buildUnresolvedDiagnosticsReport(classified)
  const measured = report.categories.find((c) => c.category === 'measured_pricing_failure')!
  assert.equal(measured.item_count, 8)
  assert.equal(measured.examples.length, 5)
})

test('buildUnresolvedDiagnosticsReport: all three categories are always present in the report, even when empty', () => {
  const report = buildUnresolvedDiagnosticsReport(classifyUnresolvedItems([item({ id: 'a', quantity: 36, unit: 'm2' })]))
  assert.deepEqual(
    report.categories.map((c) => c.category).sort(),
    ['allowance_candidate', 'measured_pricing_failure', 'true_unresolved'].sort()
  )
})
