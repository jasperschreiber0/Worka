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
import { runQualityAssurance } from '../lib/estimating/qa.ts'

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
    .select('id, builder_id, margin_pct, job_id')
    .eq('id', quoteId)
    .single()
  if (quoteErr || !quote) throw new Error(`Quote not found: ${quoteErr?.message ?? quoteId}`)

  // pricing_source must be selected here even though this script only WRITES
  // it for the subset it reprices — computeQuoteTotals's pricing_match_rate_pct
  // reads it off every included item, and an item this run doesn't touch
  // (already priced by a prior run) would otherwise come back as undefined
  // here and get counted as unreliable regardless of its real stored source.
  // Confirmed on a real run: with 0 items left to reprice, pricing_match_rate_pct
  // read back as a flat 0% instead of the true ~18%, purely from this omission.
  const { data: items, error: itemsErr } = await supabase
    .from('quote_line_items')
    .select('id, trade_category_id, description, quantity, unit, rate, total, confidence, assumption_status, pricing_source')
    .eq('quote_id', quoteId)
  if (itemsErr) throw new Error(`Could not load line items: ${itemsErr.message}`)
  if (!items || items.length === 0) throw new Error('No line items on this quote')

  const { data: builderRow } = await supabase.from('builders').select('state').eq('id', quote.builder_id).single()

  // Only re-price items that genuinely have no total yet — mirrors the fix
  // to ensureQuotePriced (lib/pricing.ts): re-running priceLineItems over
  // EVERY item (including AI Allowance / document-priced ones, which
  // legitimately have total set with rate left null) would send them
  // through priceLineItems' "no unit -> total: null" early exit and wipe
  // their real total right back out — this script had the same bug in an
  // even more direct form (no filter at all).
  const unpriced = items.filter((i) => i.total === null)
  const priced = await priceLineItems(supabase, quote.builder_id, builderRow?.state ?? null, unpriced)

  const rowsToUpdate = priced
    .map((p) => ({
      id: p.id, quote_id: quoteId,
      trade_category_id: p.trade_category_id, description: p.description,
      rate: p.rate, total: p.total,
      pricing_source: p.pricing_source, pricing_basis: p.pricing_basis, confidence: p.confidence,
    }))
    .filter((row) => row.rate !== null)

  if (rowsToUpdate.length > 0) {
    const { error } = await supabase.from('quote_line_items').upsert(rowsToUpdate)
    if (error) throw new Error(`Line item repricing failed: ${error.message}`)
  }

  // Merge re-priced items back with the ones that already had a real total
  // (allowance/document/previously-resolved) — same pattern ensureQuotePriced
  // uses, so the totals computation sees every item's real value, not just
  // the subset this script touched.
  const pricedById = new Map(priced.map((p) => [p.id, p]))
  const finalItems = items.map((item) => pricedById.get(item.id) ?? item)
  // Was missing pricing_match_rate_pct entirely — destructuring only the
  // three older fields meant it was silently never computed into this
  // script's update payload, so the column stayed null even after a
  // successful reprice. computeQuoteTotals always returns it; this was
  // purely this script not asking for it.
  const { total_cost, confidence_score, price_coverage_pct, pricing_match_rate_pct, allowance_pct } = computeQuoteTotals(finalItems)
  await supabase.from('quotes').update({ total_cost, confidence_score, price_coverage_pct, pricing_match_rate_pct, allowance_pct, margin_pct: quote.margin_pct ?? DEFAULT_MARGIN_PCT }).eq('id', quoteId)

  // Production always pairs pricing with QA (every real path calls both
  // together) — this script previously only did the pricing half, so the
  // completeness safeguard (missing_trade_details) has never actually run
  // against this quote's real generated output.
  const qaReport = await runQualityAssurance(supabase, quoteId, quote.job_id)

  console.log(JSON.stringify({
    event: 'reprice_complete', quote_id: quoteId,
    line_items_repriced_this_run: rowsToUpdate.length, line_items_total: items.length,
    total_cost, confidence_score, price_coverage_pct, pricing_match_rate_pct, allowance_pct,
    qa_top_risks: qaReport?.top_risks ?? [],
    qa_missing_trade_details: qaReport?.missing_trade_details ?? [],
    qa_review_items: qaReport?.review_items ?? [],
  }, null, 2))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'reprice_failed', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
