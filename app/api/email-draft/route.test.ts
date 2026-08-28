import { test } from 'node:test'
import assert from 'node:assert/strict'
// Relative, .ts-suffixed import — same reason lib/invoices.test.ts/lib/variations.test.ts
// document: must resolve identically under plain `node --experimental-strip-types`
// and under Next.js/webpack.
//
// NOT wired into `npm run test`'s glob (package.json only globs lib/**/*.test.ts,
// lib/estimating/*.test.ts, supabase/functions/smooth-responder/*.test.ts) —
// wiring this in would mean editing package.json, which is outside this
// round's explicitly authorized scope (app/api/email-draft/route.ts + the
// minimum necessary test file). Run directly:
//   node --experimental-strip-types --test app/api/email-draft/route.test.ts
import { loadRealJobContext, loadDemoJobContext } from './route.ts'

// ─── Minimal fake Supabase client for loadRealJobContext ───────────────────
// Covers exactly the chain shapes loadRealJobContext calls: .from(table)
// .select(cols).eq(...).single() (jobs), .select(cols).eq(...).order(...)
// .limit(1) awaited directly as an array (quotes/variations/invoices), and
// .select(cols).eq('quote_id', ...) awaited directly as an array
// (quote_line_items). Round 12 reliability audit: loadRealJobContext had no
// prior test coverage at all — this is the smallest fake that lets the
// cost-vs-client-price fix be verified without a live Supabase instance.
function makeFakeSupabase(tables: Record<string, Record<string, unknown>[]>) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      let rows = tables[table] ?? []
      const builder = {
        select() {
          return builder
        },
        eq(col: string, val: unknown) {
          rows = rows.filter((r) => r[col] === val)
          return builder
        },
        order() {
          return builder
        },
        limit() {
          return builder
        },
        single: async () => (rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'not found' } }),
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then(resolve: (result: { data: unknown[]; error: null }) => void) {
          resolve({ data: rows, error: null })
        },
      }
      return builder
    },
  }
}

const JOB_ID = 'job-1'
const BUILDER_ID = 'builder-1'

function baseJobsTable() {
  return [
    {
      id: JOB_ID,
      address: '12 Test St, Testville VIC',
      builder_id: BUILDER_ID,
      clients: { name: 'Jamie Client', email: 'jamie@example.com' },
    },
  ]
}

test('loadRealJobContext (Case 1 — cost ≠ client price): quote_amount is the canonical client price ($97,750), never total_cost ($85,000)', async () => {
  const fake = makeFakeSupabase({
    jobs: baseJobsTable(),
    quotes: [{ id: 'quote-1', job_id: JOB_ID, total_cost: 85000, sent_at: '2026-08-01', version: 1, status: 'sent' }],
    variations: [],
    invoices: [],
    quote_line_items: [{ quote_id: 'quote-1', total: 85000, margin_pct: 0.15, assumption_status: null }],
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = await loadRealJobContext(fake as any, JOB_ID, BUILDER_ID)

  assert.equal(ctx?.quote_amount, 97750)
  assert.notEqual(ctx?.quote_amount, 85000)
})

test('loadRealJobContext (Case 2 — zero margin): the canonical calculation is preserved (no markup invented, no markup dropped)', async () => {
  const fake = makeFakeSupabase({
    jobs: baseJobsTable(),
    quotes: [{ id: 'quote-2', job_id: JOB_ID, total_cost: 50000, sent_at: '2026-08-01', version: 1, status: 'sent' }],
    variations: [],
    invoices: [],
    quote_line_items: [{ quote_id: 'quote-2', total: 50000, margin_pct: 0, assumption_status: null }],
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = await loadRealJobContext(fake as any, JOB_ID, BUILDER_ID)

  assert.equal(ctx?.quote_amount, 50000)
})

test('loadRealJobContext (Case 3 — normal existing quote): the rest of the context still populates correctly alongside the fixed quote_amount', async () => {
  const fake = makeFakeSupabase({
    jobs: baseJobsTable(),
    quotes: [{ id: 'quote-3', job_id: JOB_ID, total_cost: 20000, sent_at: '3 days ago', version: 1, status: 'sent' }],
    variations: [{ job_id: JOB_ID, title: 'Extra power point', amount: 450, status: 'pending', created_at: '2026-08-01' }],
    invoices: [{ job_id: JOB_ID, amount: 5000, status: 'sent', due_date: '2099-01-01', created_at: '2026-08-01' }],
    quote_line_items: [{ quote_id: 'quote-3', total: 20000, margin_pct: 0.15, assumption_status: null }],
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = await loadRealJobContext(fake as any, JOB_ID, BUILDER_ID)

  assert.equal(ctx?.job_address, '12 Test St, Testville VIC')
  assert.equal(ctx?.client_name, 'Jamie Client')
  assert.equal(ctx?.client_email, 'jamie@example.com')
  assert.equal(ctx?.quote_amount, 23000)
  assert.equal(ctx?.quote_sent_display, '3 days ago')
  assert.equal(ctx?.latest_variation_title, 'Extra power point')
  assert.equal(ctx?.latest_variation_amount, 450)
  assert.equal(ctx?.invoice_amount, 5000)
})

test('loadRealJobContext: no quote for the job leaves quote_amount null (no line-item query attempted)', async () => {
  const fake = makeFakeSupabase({
    jobs: baseJobsTable(),
    quotes: [],
    variations: [],
    invoices: [],
    quote_line_items: [],
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = await loadRealJobContext(fake as any, JOB_ID, BUILDER_ID)

  assert.equal(ctx?.quote_amount, null)
})

test('loadDemoJobContext (Case 4 — demo context): quote_amount is the demo snapshot\'s canonical contract_value ($146,625 for the Toorak job), never quote.total_cost ($127,500)', () => {
  const ctx = loadDemoJobContext('00000000-0000-0000-0000-000000000011')

  assert.equal(ctx?.quote_amount, 146625)
  assert.notEqual(ctx?.quote_amount, 127500)
})
