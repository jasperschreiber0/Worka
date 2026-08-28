import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildVariationLineItemInsert, applyApprovedVariationToQuote, type ApprovedVariation } from './variations.ts'

// ─── Minimal fake Supabase client for applyApprovedVariationToQuote ────────
// Covers exactly the chain shapes applyApprovedVariationToQuote (and the
// recomputeQuoteTotals it calls afterward, lib/pricing.ts) use: select/eq/
// maybeSingle or single, insert/select/single, and update/eq (fire-and-
// forget from this function's point of view — recomputeQuoteTotals swallows
// its own errors). Round 11 reliability audit: applyApprovedVariationToQuote
// had no prior test coverage of its DB-query logic at all (only the pure
// buildVariationLineItemInsert helper was tested) — this is the smallest
// fake that lets the is_current quote-selection be verified end to end,
// including the actual line-item insert, without a live Supabase instance.
function makeFakeSupabase(seed: { quotes: Record<string, unknown>[]; quote_line_items: Record<string, unknown>[] }) {
  const tables: { quotes: Record<string, unknown>[]; quote_line_items: Record<string, unknown>[] } = {
    quotes: [...seed.quotes],
    quote_line_items: [...seed.quote_line_items],
  }
  let nextId = 1
  return {
    tables,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: 'quotes' | 'quote_line_items'): any {
      let rows = tables[table]
      let insertedRow: Record<string, unknown> | null = null
      const builder = {
        select() {
          return builder
        },
        eq(col: string, val: unknown) {
          rows = rows.filter((r) => r[col] === val)
          return builder
        },
        insert(payload: Record<string, unknown>) {
          insertedRow = { id: `generated-${table}-${nextId++}`, ...payload }
          tables[table] = [...tables[table], insertedRow]
          return builder
        },
        update(payload: Record<string, unknown>) {
          rows.forEach((r) => Object.assign(r, payload))
          return builder
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        single: async () => {
          if (insertedRow) return { data: insertedRow, error: null }
          return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'not found' } }
        },
        then(resolve: (result: { data: unknown[]; error: null }) => void) {
          resolve({ data: rows, error: null })
        },
      }
      return builder
    },
  }
}

function makeVariation(overrides: Partial<ApprovedVariation> = {}): ApprovedVariation {
  return {
    id: 'variation-1',
    job_id: 'job-1',
    title: 'Upgrade to stone benchtops',
    amount: 3200,
    trade_category_id: 8,
    ...overrides,
  }
}

test('buildVariationLineItemInsert: description is prefixed so it is recognisable in QuoteView, not a mystery line', () => {
  const insert = buildVariationLineItemInsert(makeVariation(), 'quote-1')
  assert.equal(insert.description, 'Variation: Upgrade to stone benchtops')
})

test('buildVariationLineItemInsert: total equals the variation amount unchanged — no markup, no GST arithmetic invented', () => {
  const insert = buildVariationLineItemInsert(makeVariation({ amount: 3200.456 }), 'quote-1')
  // round2 only — never a margin multiplication, never a GST division.
  assert.equal(insert.total, 3200.46)
})

test('buildVariationLineItemInsert: margin_pct is 0 so calculateClientPrice() passes the amount straight through unmarked-up', () => {
  const insert = buildVariationLineItemInsert(makeVariation(), 'quote-1')
  assert.equal(insert.margin_pct, 0)
})

test('buildVariationLineItemInsert: quantity/unit/rate are null — a lump-sum line, same shape as an existing PC/PS allowance', () => {
  const insert = buildVariationLineItemInsert(makeVariation(), 'quote-1')
  assert.equal(insert.quantity, null)
  assert.equal(insert.unit, null)
  assert.equal(insert.rate, null)
})

test('buildVariationLineItemInsert: carries the variation_id back-reference and the variation pricing_source/provenance tags', () => {
  const insert = buildVariationLineItemInsert(makeVariation({ id: 'variation-42' }), 'quote-1')
  assert.equal(insert.variation_id, 'variation-42')
  assert.equal(insert.pricing_source, 'variation')
  assert.equal(insert.predicted_by, 'human')
  assert.equal(insert.confidence, 100)
  assert.equal(insert.is_assumption, false)
  assert.equal(insert.assumption_status, null)
  assert.equal(insert.pricing_basis, null)
})

test('buildVariationLineItemInsert: carries the given quote_id and trade_category_id through unchanged', () => {
  const insert = buildVariationLineItemInsert(makeVariation({ trade_category_id: 12 }), 'quote-99')
  assert.equal(insert.quote_id, 'quote-99')
  assert.equal(insert.trade_category_id, 12)
})

test('buildVariationLineItemInsert: throws when trade_category_id is null — callers must check first, never silently default a trade', () => {
  assert.throws(() => buildVariationLineItemInsert(makeVariation({ trade_category_id: null }), 'quote-1'))
})

// ─── Round 11 Finding #1: applyApprovedVariationToQuote must apply against the is_current quote, not the highest-version one ───

test('applyApprovedVariationToQuote (Case C): applies the variation to the is_current=true quote ($100,000 quote), not the higher-version non-current one ($20,000 quote)', async () => {
  const fake = makeFakeSupabase({
    quotes: [
      { id: 'quote-a', job_id: 'job-1', is_current: true, version: 1, margin_pct: 0.15 },
      { id: 'quote-b', job_id: 'job-1', is_current: false, version: 2, margin_pct: 0.15 },
    ],
    quote_line_items: [],
  })

  const result = await applyApprovedVariationToQuote(
    fake as unknown as import('@supabase/supabase-js').SupabaseClient,
    makeVariation({ job_id: 'job-1' })
  )

  assert.equal(result.applied, true)
  const insertedLine = fake.tables.quote_line_items.find((r) => r.description === 'Variation: Upgrade to stone benchtops')
  assert.ok(insertedLine, 'expected the variation line item to be inserted')
  assert.equal(insertedLine!.quote_id, 'quote-a')
})
