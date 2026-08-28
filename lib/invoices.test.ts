import { test } from 'node:test'
import assert from 'node:assert/strict'
// Relative, .ts-suffixed import — same reason variations.test.ts/pricing.test.ts
// document: must resolve identically under plain `node --experimental-strip-types`
// and under Next.js/webpack.
import { computeInvoiceTotals, wouldExceedContractValue, deriveInvoiceStatus, withDerivedStatus, getContractValueForJob } from './invoices.ts'

// ─── Minimal fake Supabase client for getContractValueForJob ───────────────
// Only implements the chain shapes getContractValueForJob actually calls:
// .from(table).select(cols).eq(col,val).eq(col2,val2).maybeSingle(), and
// .from(table).select(cols).eq(col,val) awaited directly (array result).
// Round 11 reliability audit: getContractValueForJob had no prior test
// coverage at all (DB-dependent, no injectable-client test existed) — this
// is the smallest fake that lets the is_current selection be verified
// without a live Supabase instance.
function makeFakeSupabase(tables: { quotes: Record<string, unknown>[]; quote_line_items: Record<string, unknown>[] }) {
  return {
    from(table: 'quotes' | 'quote_line_items') {
      let rows = tables[table]
      const builder = {
        select() {
          return builder
        },
        eq(col: string, val: unknown) {
          rows = rows.filter((r) => r[col] === val)
          return builder
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then(resolve: (result: { data: unknown[]; error: null }) => void) {
          resolve({ data: rows, error: null })
        },
      }
      return builder
    },
  }
}

test('deriveInvoiceStatus: a sent invoice with a past due_date is overdue', () => {
  const status = deriveInvoiceStatus({ status: 'sent', due_date: '2020-01-01' })
  assert.equal(status, 'overdue')
})

test('deriveInvoiceStatus: a sent invoice with a future due_date stays sent', () => {
  const status = deriveInvoiceStatus({ status: 'sent', due_date: '2999-01-01' })
  assert.equal(status, 'sent')
})

test('deriveInvoiceStatus: a sent invoice with no due_date stays sent (nothing to be overdue against)', () => {
  const status = deriveInvoiceStatus({ status: 'sent', due_date: null })
  assert.equal(status, 'sent')
})

test('deriveInvoiceStatus: draft and paid are never derived to overdue regardless of due_date', () => {
  assert.equal(deriveInvoiceStatus({ status: 'draft', due_date: '2020-01-01' }), 'draft')
  assert.equal(deriveInvoiceStatus({ status: 'paid', due_date: '2020-01-01' }), 'paid')
})

test('withDerivedStatus: maps a list without mutating the input objects', () => {
  const input = [{ status: 'sent', due_date: '2020-01-01' }]
  const output = withDerivedStatus(input)
  assert.equal(output[0].status, 'overdue')
  assert.equal(input[0].status, 'sent') // original untouched
})

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

// ─── Round 11 Finding #1: getContractValueForJob must select is_current, not highest version ───

test('getContractValueForJob (Case A — divergent quotes): selects the is_current=true quote ($100,000), not the higher-version non-current one ($20,000)', async () => {
  const supabase = makeFakeSupabase({
    quotes: [
      { id: 'quote-a', job_id: 'job-1', is_current: true, version: 1 },
      { id: 'quote-b', job_id: 'job-1', is_current: false, version: 2 },
    ],
    quote_line_items: [
      { quote_id: 'quote-a', total: 100000, margin_pct: 0, assumption_status: null },
      { quote_id: 'quote-b', total: 20000, margin_pct: 0, assumption_status: null },
    ],
  })
  const value = await getContractValueForJob(supabase, 'job-1')
  assert.equal(value, 100000)
})

test('getContractValueForJob (Case B — normal single quote): a single is_current=true quote resolves exactly as before', async () => {
  const supabase = makeFakeSupabase({
    quotes: [{ id: 'quote-only', job_id: 'job-2', is_current: true, version: 1 }],
    quote_line_items: [{ quote_id: 'quote-only', total: 50000, margin_pct: 0.1, assumption_status: null }],
  })
  const value = await getContractValueForJob(supabase, 'job-2')
  assert.equal(value, 55000)
})

test('getContractValueForJob: no quote for the job returns null', async () => {
  const supabase = makeFakeSupabase({ quotes: [], quote_line_items: [] })
  const value = await getContractValueForJob(supabase, 'job-none')
  assert.equal(value, null)
})
