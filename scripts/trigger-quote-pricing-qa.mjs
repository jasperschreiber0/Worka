#!/usr/bin/env node
// ============================================================
// WorkA — invoke the REAL, EXISTING production quote-read pipeline
// against a specific quote, to trigger its existing lazy pricing/QA
// backfill (GET /api/quotes/[quoteId]/route.ts: ensureQuotePriced()
// unconditionally, then runQualityAssurance() if qa_report is null).
// ============================================================
// Not a new pipeline -- this is the same route a builder's browser hits
// when opening a quote. Authenticates via the documented internal
// server-to-server path (lib/auth/api-auth.ts): Authorization: Bearer
// $SUPABASE_SERVICE_ROLE_KEY + x-worka-builder-id header.
//
// Usage:
//   APP_URL=... SUPABASE_SERVICE_ROLE_KEY=... QUOTE_ID=... BUILDER_ID=... \
//   node scripts/trigger-quote-pricing-qa.mjs
// ============================================================

const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const QUOTE_ID = process.env.QUOTE_ID
const BUILDER_ID = process.env.BUILDER_ID

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

async function main() {
  if (!APP_URL || !SERVICE_ROLE_KEY || !QUOTE_ID || !BUILDER_ID) {
    log('config_error', { message: 'APP_URL, SUPABASE_SERVICE_ROLE_KEY, QUOTE_ID, BUILDER_ID required' })
    process.exit(1)
  }

  const url = `${APP_URL.replace(/\/$/, '')}/api/quotes/${QUOTE_ID}`
  log('quote_route_call_started', { url })

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'x-worka-builder-id': BUILDER_ID,
    },
  })
  const body = await res.json().catch(() => ({}))

  if (!res.ok) {
    log('quote_route_call_failed', { status: res.status, body })
    process.exit(1)
  }

  const quote = body.quote ?? {}
  const items = Object.values(body.line_items_by_category ?? {}).flat()
  const priced = items.filter((i) => i.rate !== null || i.pricing_type === 'provisional_sum')

  log('quote_route_call_complete', {
    status: res.status,
    quote_status: quote.status,
    total_cost: quote.total_cost,
    margin_pct: quote.margin_pct,
    confidence_score: quote.confidence_score,
    has_qa_report: Boolean(body.qa_report),
    qa_report: body.qa_report ?? null,
    summary: body.summary ?? null,
    line_item_count: items.length,
    priced_line_item_count: priced.length,
  })
  process.exit(0)
}

main().catch((err) => {
  log('quote_route_call_error', { message: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
