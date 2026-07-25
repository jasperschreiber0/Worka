#!/usr/bin/env node
// ============================================================
// WorkA — dev-mode: trace the pricing persistence lifecycle for a quote
// ============================================================
// PURPOSE: investigation only — makes ZERO database writes. Calls the real,
// unmodified priceLineItems (lib/pricing.ts) in dry-run mode against every
// line item on this quote whose pricing_source is null or not one of the
// ten values migration 072 defines, to answer: did a pricing resolver
// already compute a correct rate/total for this item, and if so, via which
// tier — reconstructing what SHOULD have been persisted alongside the total
// that already IS persisted.
//
// Does not call ensureQuotePriced or dev-reprice-quote.mjs (both would
// write to the DB). Does not modify any existing file. Produces no fix.
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node --experimental-strip-types scripts/dev-trace-pricing-lifecycle.mjs \
//       --quote-id=<uuid>
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { priceLineItems } from '../lib/pricing.ts'
import { tradeCategoryName } from '../lib/trade-taxonomy.ts'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=')
    return [k, rest.join('=')]
  })
)

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
if (!args['quote-id']) {
  console.error('Required: --quote-id=<uuid>')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
const quoteId = args['quote-id']
const money = (n) => (n === null || n === undefined ? 'null' : `$${Math.round(n).toLocaleString('en-AU')}`)

const KNOWN_SOURCES = new Set([
  'document', 'cost_rates_exact', 'cost_rates_normalized', 'category_rate',
  'builder_rate', 'network_rate', 'ai_measured_rate', 'ai_allowance', 'manual', 'unresolved',
])

async function main() {
  const { data: quote, error: quoteErr } = await supabase
    .from('quotes')
    .select('id, builder_id, total_cost, margin_pct')
    .eq('id', quoteId)
    .single()
  if (quoteErr || !quote) throw new Error(`Quote not found: ${quoteErr?.message ?? quoteId}`)

  console.log('='.repeat(72))
  console.log('PRICING PERSISTENCE LIFECYCLE TRACE — read-only, ZERO database writes')
  console.log('='.repeat(72))
  console.log(`Quote:              ${quoteId}`)
  console.log(`quotes.total_cost:  ${money(quote.total_cost)}`)

  // ── Q3: is ensureQuotePriced actually reachable for this quote? ──────────
  // ensureQuotePriced (lib/pricing.ts:714) bails out immediately if
  // quote.total_cost !== null, before ever calling priceLineItems. This is
  // the exact guard — reproduced here read-only, not called.
  console.log('\n' + '-'.repeat(72))
  console.log('Q3/Q4: would ensureQuotePriced(quoteId) run priceLineItems today?')
  console.log('-'.repeat(72))
  if (quote.total_cost !== null) {
    console.log('NO. ensureQuotePriced returns false immediately (lib/pricing.ts:714,')
    console.log('`if (!quote || quote.total_cost !== null) return false`) because this')
    console.log('quote already has a non-null total_cost. priceLineItems — and therefore')
    console.log('every cost_rates/builder_rate/network_rate matching tier inside it — is')
    console.log('never reached via either of the two real production call sites:')
    console.log('  app/api/quotes/[quoteId]/route.ts:234 (quote GET, lazy backfill)')
    console.log('  app/api/intake/[fileId]/route.ts:905  (SSE poller on extraction complete)')
    console.log('This is true regardless of how many individual line items still have a')
    console.log('null pricing_source or a total that looks unresolved.')
  } else {
    console.log('YES — total_cost is currently null, so the next call to either production')
    console.log('call site would run priceLineItems for real and persist its results.')
  }

  const { data: items, error: itemsErr } = await supabase
    .from('quote_line_items')
    .select('id, trade_category_id, description, quantity, unit, rate, total, confidence, assumption_status, pricing_source, pricing_basis')
    .eq('quote_id', quoteId)
  if (itemsErr) throw new Error(`Could not load line items: ${itemsErr.message}`)

  const included = items.filter((i) => i.assumption_status !== 'excluded')
  const flagged = included.filter((i) => i.total !== null && !KNOWN_SOURCES.has(i.pricing_source))

  console.log('\n' + '-'.repeat(72))
  console.log(`Q1/Q2: items with a populated total but null/unrecognised pricing_source`)
  console.log('-'.repeat(72))
  console.log(`Found: ${flagged.length} of ${included.length} included items`)

  if (flagged.length === 0) {
    console.log('\nNothing to trace — no items currently match this pattern.')
    return
  }

  const { data: builderRow } = await supabase.from('builders').select('state').eq('id', quote.builder_id).single()

  // Dry run: call the REAL priceLineItems (unmodified) as if these items
  // were still unpriced, to see what tier/rate it resolves them to TODAY.
  // This does not write anything — the result is only ever logged.
  const dryRunInput = flagged.map((i) => ({
    id: i.id, trade_category_id: i.trade_category_id, description: i.description,
    quantity: i.quantity, unit: i.unit, confidence: i.confidence,
  }))
  const dryRun = await priceLineItems(supabase, quote.builder_id, builderRow?.state ?? null, dryRunInput)
  const dryRunById = new Map(dryRun.map((r) => [r.id, r]))

  console.log('\nFor each: [A] what is CURRENTLY stored in the DB vs [B] what priceLineItems')
  console.log('resolves it to TODAY if run again (dry run only — nothing written).\n')

  let matchCount = 0
  for (const item of flagged) {
    const dry = dryRunById.get(item.id)
    const totalsMatch = dry && dry.total !== null && Math.abs((dry.total ?? 0) - (item.total ?? 0)) < 0.01
    if (totalsMatch) matchCount++

    console.log('='.repeat(60))
    console.log(`Item: ${item.id}`)
    console.log(`Trade: ${tradeCategoryName(item.trade_category_id)}`)
    console.log(`Description: ${item.description}`)
    console.log(`Input: quantity=${item.quantity ?? 'null'} unit=${item.unit ?? 'null'}`)
    console.log('')
    console.log(`[A] STORED IN DB TODAY:`)
    console.log(`    rate=${money(item.rate)}  total=${money(item.total)}`)
    console.log(`    pricing_source=${item.pricing_source ?? 'null'}  pricing_basis=${item.pricing_basis ?? 'null'}`)
    console.log('')
    if (dry) {
      console.log(`[B] priceLineItems RESOLVES TODAY (dry run, not written):`)
      console.log(`    rate=${money(dry.rate)}  total=${money(dry.total)}`)
      console.log(`    pricing_source=${dry.pricing_source ?? 'null'}  pricing_basis=${dry.pricing_basis ?? 'null'}`)
      console.log(`    confidence=${dry.confidence ?? 'null'}`)
      console.log('')
      console.log(`    would-be DB write payload (the payload a fixed re-run would upsert):`)
      console.log(`    ${JSON.stringify({ id: item.id, rate: dry.rate, total: dry.total, pricing_source: dry.pricing_source, pricing_basis: dry.pricing_basis, confidence: dry.confidence })}`)
      console.log('')
      console.log(`    totals match stored value: ${totalsMatch ? 'YES — consistent with "computed correctly, just never tagged"' : 'NO — see note below'}`)
    } else {
      console.log('[B] priceLineItems returned no result for this item (unexpected).')
    }
    console.log('')
  }

  console.log('='.repeat(72))
  console.log('SUMMARY')
  console.log('='.repeat(72))
  console.log(`${flagged.length} items traced. ${matchCount} of ${flagged.length} produced the SAME total`)
  console.log('when re-run today as what is currently stored in the DB — strong evidence')
  console.log('those totals were genuinely computed by priceLineItems (reaching real')
  console.log('cost_rates/category-fallback/AI-measured-rate matching) at some point, and')
  console.log('only the pricing_source/pricing_basis/confidence write was dropped, not the')
  console.log('total itself.')
  if (matchCount < flagged.length) {
    console.log(`${flagged.length - matchCount} item(s) produced a DIFFERENT total on this dry run than what`)
    console.log('is stored — for these, either the rate catalogue/learned rates have changed')
    console.log('since the original total was written, or that total came from a different')
    console.log('origin entirely (not priceLineItems) — worth a closer individual look before')
    console.log('assuming the same root cause applies.')
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'trace_pricing_lifecycle_failed', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
