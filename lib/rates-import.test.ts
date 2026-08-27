import { test } from 'node:test'
import assert from 'node:assert/strict'
// Relative, .ts-suffixed imports — same reason invoices.ts/variations.ts's
// own tests document: must resolve identically under plain
// `node --experimental-strip-types` and under Next.js/webpack.
import { planSupplierRateImport, type SupplierRateInput } from './rates-import.ts'
import { tokenize, type CatalogueEntry } from './pricing.ts'

// A small, realistic slice of the real catalogue (migration 017's actual
// seeded rows) — enough to exercise matching without depending on a live
// database.
function entry(key: string, tradeCategoryId: number, description: string, unit: string): CatalogueEntry {
  return { line_item_key: key, trade_category_id: tradeCategoryId, description, unit, tokens: tokenize(description) }
}

const CATALOGUE: CatalogueEntry[] = [
  entry('site_slab', 1, 'Concrete slab on ground', 'm2'),
  entry('site_excavation', 1, 'Excavation & earthworks', 'm3'),
  entry('framing_wall', 2, 'Wall framing', 'lm'),
]

function supplierRow(overrides: Partial<SupplierRateInput> = {}): SupplierRateInput {
  return {
    trade_category_id: 1,
    trade_category_name: 'Site Works & Concrete',
    description: 'Concrete slab on ground',
    unit: 'm2',
    rate: 150,
    ...overrides,
  }
}

test('planSupplierRateImport: a description matching a real catalogue entry is stored under the CATALOGUE key, not a derived one', () => {
  const plan = planSupplierRateImport([supplierRow()], CATALOGUE, 'builder-1', 'ACME Concrete', '2026-01-01T00:00:00.000Z')
  assert.equal(plan.matched.length, 1)
  assert.equal(plan.unmatched.length, 0)
  assert.equal(plan.matched[0].line_item_key, 'site_slab')
  assert.notEqual(plan.matched[0].line_item_key, '1_concrete_slab_on_ground')
})

test('planSupplierRateImport: an unmatched description is reported, never silently persisted', () => {
  const plan = planSupplierRateImport(
    [supplierRow({ description: 'Bespoke ornamental gate hinges', trade_category_id: 1 })],
    CATALOGUE,
    'builder-1',
    'ACME Concrete',
    '2026-01-01T00:00:00.000Z'
  )
  assert.equal(plan.matched.length, 0)
  assert.equal(plan.unmatched.length, 1)
  assert.equal(plan.unmatched[0].description, 'Bespoke ornamental gate hinges')
})

test('planSupplierRateImport: a wrong trade_category_id for an otherwise-matching description is unmatched, not cross-matched', () => {
  const plan = planSupplierRateImport(
    [supplierRow({ description: 'Concrete slab on ground', trade_category_id: 2 })],
    CATALOGUE,
    'builder-1',
    'ACME Concrete',
    '2026-01-01T00:00:00.000Z'
  )
  assert.equal(plan.matched.length, 0)
  assert.equal(plan.unmatched.length, 1)
})

test('planSupplierRateImport: an incompatible unit for an otherwise-matching description is unmatched', () => {
  const plan = planSupplierRateImport(
    [supplierRow({ unit: 'each' })],
    CATALOGUE,
    'builder-1',
    'ACME Concrete',
    '2026-01-01T00:00:00.000Z'
  )
  assert.equal(plan.matched.length, 0)
  assert.equal(plan.unmatched.length, 1)
})

test('planSupplierRateImport: carries the caller-supplied builder_id/supplier_name/imported_at through onto every matched row', () => {
  const plan = planSupplierRateImport([supplierRow()], CATALOGUE, 'builder-42', 'Bunnings Trade', '2026-06-01T00:00:00.000Z')
  assert.equal(plan.matched[0].builder_id, 'builder-42')
  assert.equal(plan.matched[0].supplier_name, 'Bunnings Trade')
  assert.equal(plan.matched[0].imported_at, '2026-06-01T00:00:00.000Z')
  assert.equal(plan.matched[0].rate, 150)
})

test('planSupplierRateImport: a mixed batch correctly partitions matched and unmatched rows independently', () => {
  const plan = planSupplierRateImport(
    [
      supplierRow({ description: 'Concrete slab on ground' }),
      supplierRow({ description: 'Excavation and earthworks', unit: 'm3' }),
      supplierRow({ description: 'Fully bespoke unmatched item', unit: 'each' }),
    ],
    CATALOGUE,
    'builder-1',
    'ACME Concrete',
    '2026-01-01T00:00:00.000Z'
  )
  assert.equal(plan.matched.length, 2)
  assert.equal(plan.unmatched.length, 1)
  assert.deepEqual(plan.matched.map((m) => m.line_item_key).sort(), ['site_excavation', 'site_slab'])
})

test('planSupplierRateImport: two different supplier rows matching the SAME catalogue entry both come through matched (upsert/dedup is the caller\'s concern, not this function\'s)', () => {
  const plan = planSupplierRateImport(
    [supplierRow(), supplierRow({ rate: 175 })],
    CATALOGUE,
    'builder-1',
    'ACME Concrete',
    '2026-01-01T00:00:00.000Z'
  )
  assert.equal(plan.matched.length, 2)
  assert.equal(plan.matched[0].line_item_key, 'site_slab')
  assert.equal(plan.matched[1].line_item_key, 'site_slab')
})
