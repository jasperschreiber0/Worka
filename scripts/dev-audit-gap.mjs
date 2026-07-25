#!/usr/bin/env node
// ============================================================
// WorkA — dev-mode: gap audit report for a generated quote
// ============================================================
// PURPOSE: visibility only — does not change any pricing, allowance, or
// trade-generation behaviour. Reads the current quote and reports where its
// dollar value actually comes from (measured/matched vs. fallback-tier vs.
// allowance) and where it's structurally incomplete (a scoped trade with no
// line items), ranked by estimated dollar impact where an impact can
// honestly be estimated — this script never fabricates a missing trade's
// dollar value as if it were a real figure; where it offers a rough
// illustrative proxy, it's labelled as exactly that.
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node --experimental-strip-types scripts/dev-audit-gap.mjs \
//       --quote-id=<uuid> --job-id=<uuid> [--benchmark=2300000]
// ============================================================

import { createClient } from '@supabase/supabase-js'
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
if (!args['quote-id'] || !args['job-id']) {
  console.error('Required: --quote-id=<uuid> --job-id=<uuid> [--benchmark=2300000]')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
const quoteId = args['quote-id']
const jobId = args['job-id']
const benchmark = args.benchmark ? Number(args.benchmark) : null

const money = (n) => `$${Math.round(n).toLocaleString('en-AU')}`

async function main() {
  const { data: quote, error: quoteErr } = await supabase
    .from('quotes')
    .select('id, total_cost, confidence_score, price_coverage_pct, pricing_match_rate_pct, allowance_pct')
    .eq('id', quoteId)
    .single()
  if (quoteErr || !quote) throw new Error(`Quote not found: ${quoteErr?.message ?? quoteId}`)

  const { data: items, error: itemsErr } = await supabase
    .from('quote_line_items')
    .select('id, trade_category_id, description, quantity, unit, rate, total, confidence, assumption_status, pricing_type, pricing_source, pricing_basis')
    .eq('quote_id', quoteId)
  if (itemsErr) throw new Error(`Could not load line items: ${itemsErr.message}`)

  const { data: scopeRows } = await supabase
    .from('scope_items')
    .select('trade_category_id, included_scope')
    .eq('job_id', jobId)

  const included = items.filter((i) => i.assumption_status !== 'excluded')

  // ── 1. Missing trade/scope ────────────────────────────────────────────
  const tradesWithItems = new Set(included.map((i) => i.trade_category_id))
  const missingTrades = (scopeRows ?? [])
    .filter((s) => s.included_scope?.length > 0 && !tradesWithItems.has(s.trade_category_id))
    .map((s) => ({
      trade_category_id: s.trade_category_id,
      trade_name: tradeCategoryName(s.trade_category_id),
      expected_scope: s.included_scope,
    }))

  // Illustrative proxy only, never presented as a real figure: the average
  // total per priced trade, applied to a missing trade's item count as a
  // rough sense of scale. Explicitly not how the real $ would be derived —
  // that requires actually generating line items for the trade.
  const tradeTotals = new Map()
  for (const i of included) {
    if (i.total === null) continue
    tradeTotals.set(i.trade_category_id, (tradeTotals.get(i.trade_category_id) ?? 0) + i.total)
  }
  const avgTradeTotal = tradeTotals.size > 0
    ? Array.from(tradeTotals.values()).reduce((a, b) => a + b, 0) / tradeTotals.size
    : 0

  // ── 2. Unresolved items ───────────────────────────────────────────────
  const unresolved = included.filter((i) => i.total === null)

  // ── 3. Allowance items (ai_allowance), ranked by $ ────────────────────
  const allowances = included
    .filter((i) => i.pricing_source === 'ai_allowance')
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
  const allowanceValue = allowances.reduce((sum, i) => sum + (i.total ?? 0), 0)

  // ── 4. Measured / reliably-matched items ──────────────────────────────
  const measuredReliable = included.filter((i) => i.pricing_source === 'cost_rates_exact' || i.pricing_source === 'cost_rates_normalized' || i.pricing_source === 'document' || i.pricing_source === 'builder_rate' || i.pricing_source === 'network_rate')
  const measuredReliableValue = measuredReliable.reduce((sum, i) => sum + (i.total ?? 0), 0)

  // ── 5. Pricing fallback items (category_rate / ai_measured_rate) ─────
  const fallbackPriced = included.filter((i) => i.pricing_source === 'category_rate' || i.pricing_source === 'ai_measured_rate')
  const fallbackValue = fallbackPriced.reduce((sum, i) => sum + (i.total ?? 0), 0)

  // ── Report ─────────────────────────────────────────────────────────────
  console.log('='.repeat(72))
  console.log('GAP AUDIT REPORT — visibility only, no pricing/allowance changes made')
  console.log('='.repeat(72))
  console.log(`Quote:              ${quoteId}`)
  console.log(`Current total_cost: ${money(quote.total_cost ?? 0)}`)
  if (benchmark) {
    const gap = benchmark - (quote.total_cost ?? 0)
    console.log(`Benchmark:          ${money(benchmark)}`)
    console.log(`Gap:                ${money(gap)}  (current is ${Math.round(((quote.total_cost ?? 0) / benchmark) * 100)}% of benchmark)`)
  }
  console.log(`price_coverage_pct:      ${quote.price_coverage_pct}%`)
  console.log(`pricing_match_rate_pct:  ${quote.pricing_match_rate_pct}%`)
  console.log(`allowance_pct:           ${quote.allowance_pct}%`)

  console.log('\n' + '-'.repeat(72))
  console.log('RANKED BY ESTIMATED DOLLAR IMPACT / SIGNIFICANCE')
  console.log('-'.repeat(72))

  const ranked = []
  if (missingTrades.length > 0) {
    ranked.push({
      category: 'Missing trade/scope', count: missingTrades.length,
      dollar: `unknown — ${missingTrades.length} scoped trade(s) with ZERO line items (illustrative proxy only: ~${money(avgTradeTotal * missingTrades.length)}, based on this quote's own average trade total — NOT a real estimate)`,
      note: 'Requires generation, not pricing, to close.',
    })
  }
  ranked.push({ category: 'Allowance items (ai_allowance)', count: allowances.length, dollar: money(allowanceValue), note: `${quote.allowance_pct}% of total_cost — judgment calls, not measured/matched.` })
  ranked.push({ category: 'Pricing fallback (category_rate / ai_measured_rate)', count: fallbackPriced.length, dollar: money(fallbackValue), note: 'Priced, but not a confirmed rate match — see pricing_match_rate_pct.' })
  ranked.push({ category: 'Measured / reliably matched', count: measuredReliable.length, dollar: money(measuredReliableValue), note: 'The reliable baseline — document, exact/normalized cost_rates, builder/network rate.' })
  if (unresolved.length > 0) {
    ranked.push({ category: 'Unresolved (still $0)', count: unresolved.length, dollar: '$0 (excluded from total)', note: 'Genuinely no source found at any tier.' })
  }
  for (const r of ranked) {
    console.log(`\n${r.category}`)
    console.log(`  items: ${r.count}   value: ${r.dollar}`)
    console.log(`  ${r.note}`)
  }

  if (missingTrades.length > 0) {
    console.log('\n' + '-'.repeat(72))
    console.log('MISSING TRADE/SCOPE DETAIL')
    console.log('-'.repeat(72))
    for (const m of missingTrades) {
      console.log(`\n${m.trade_name} (trade ${m.trade_category_id}) — 0 line items generated`)
      console.log(`  Expected scope: ${m.expected_scope.slice(0, 5).join('; ')}${m.expected_scope.length > 5 ? ` (+${m.expected_scope.length - 5} more)` : ''}`)
    }
  }

  console.log('\n' + '-'.repeat(72))
  console.log(`LARGEST ALLOWANCES (${allowances.length} total, ranked by $ descending)`)
  console.log('-'.repeat(72))
  for (const a of allowances.slice(0, 20)) {
    console.log(`\nTrade:      ${tradeCategoryName(a.trade_category_id)}`)
    console.log(`Item:       ${a.description}`)
    console.log(`Allowance:  ${money(a.total ?? 0)}`)
    console.log(`Confidence: ${a.confidence}%`)
    console.log(`Reasoning:  ${a.pricing_basis ?? '(none recorded)'}`)
  }
  if (allowances.length > 20) console.log(`\n... and ${allowances.length - 20} more (use --benchmark to adjust, or query directly for the full list)`)

  if (unresolved.length > 0) {
    console.log('\n' + '-'.repeat(72))
    console.log(`UNRESOLVED ITEMS (${unresolved.length}) — still $0`)
    console.log('-'.repeat(72))
    for (const u of unresolved.slice(0, 20)) {
      console.log(`  [${tradeCategoryName(u.trade_category_id)}] ${u.description}`)
    }
  }

  console.log('\n' + '='.repeat(72))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'audit_gap_failed', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
