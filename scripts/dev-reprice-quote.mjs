#!/usr/bin/env node
// ============================================================
// WorkA — dev-mode: force-reprice an already-priced quote
// ============================================================
// ensureQuotePriced (lib/pricing.ts) is idempotent by design — it refuses
// to touch a quote whose total_cost is already non-null. That's the right
// behaviour in production, but it means a quote whose line items were
// priced in-memory correctly (total_cost got written) while the actual
// per-line-item rate/total write failed (see the quote_id NOT NULL upsert
// bug this pass fixed in lib/pricing.ts) can't self-heal just by being
// viewed again — the app's own lazy-backfill-on-GET never fires for it.
// This script re-runs pricing unconditionally for one quote_id, ignoring
// that guard, so an already-generated dev-mode estimate can be repaired
// without regenerating it (no new Claude calls).
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node --experimental-strip-types scripts/dev-reprice-quote.mjs --quote-id=<uuid>
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { priceLineItems, computeQuoteTotals, DEFAULT_MARGIN_PCT } from '../lib/pricing.ts'

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

async function main() {
  const { data: quote, error: quoteErr } = await supabase
    .from('quotes')
    .select('id, builder_id, margin_pct')
    .eq('id', quoteId)
    .single()
  if (quoteErr || !quote) throw new Error(`Quote not found: ${quoteErr?.message ?? quoteId}`)

  const { data: items, error: itemsErr } = await supabase
    .from('quote_line_items')
    .select('id, trade_category_id, description, quantity, unit, rate, total, confidence, assumption_status')
    .eq('quote_id', quoteId)
  if (itemsErr) throw new Error(`Could not load line items: ${itemsErr.message}`)
  if (!items || items.length === 0) throw new Error('No line items on this quote')

  const { data: builderRow } = await supabase.from('builders').select('state').eq('id', quote.builder_id).single()

  const priced = await priceLineItems(supabase, quote.builder_id, builderRow?.state ?? null, items)

  const rowsToUpdate = priced
    .map((p) => ({
      id: p.id, quote_id: quoteId,
      trade_category_id: p.trade_category_id, description: p.description,
      rate: p.rate, total: p.total,
    }))
    .filter((row) => row.rate !== null)

  if (rowsToUpdate.length > 0) {
    const { error } = await supabase.from('quote_line_items').upsert(rowsToUpdate)
    if (error) throw new Error(`Line item repricing failed: ${error.message}`)
  }

  const { total_cost, confidence_score } = computeQuoteTotals(priced)
  await supabase.from('quotes').update({ total_cost, confidence_score, margin_pct: quote.margin_pct ?? DEFAULT_MARGIN_PCT }).eq('id', quoteId)

  console.log(JSON.stringify({
    event: 'reprice_complete', quote_id: quoteId,
    line_items_priced: rowsToUpdate.length, line_items_total: items.length,
    total_cost, confidence_score,
  }, null, 2))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'reprice_failed', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
