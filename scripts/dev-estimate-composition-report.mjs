#!/usr/bin/env node
// ============================================================
// WorkA — dev-mode: canonical estimate composition report
// ============================================================
// PURPOSE: visibility only — this script does not price, allowance, gate,
// or otherwise modify anything. It exists to answer one question before any
// new pricing infrastructure is built: of the quote's current dollar value,
// how much genuinely came from a reliable measured source vs. a fallback
// tier vs. an AI judgment call vs. a builder override — and where does the
// gap to a benchmark figure most likely come from.
//
// Classifies by ACTUAL STATE, not by trusting pricing_source in isolation:
//   - total IS NULL (and not excluded) always wins → true_unresolved,
//     regardless of what pricing_source says (a prior session found a
//     dev-script bucketer that trusted pricing_source alone and silently
//     mislabelled items — see git history on this branch, "dev-recover-
//     missing-trades.mjs bucketOf bug" — this script exists partly to not
//     repeat that mistake).
//   - pricing_type = 'provisional_sum' always wins next → provisional_sums,
//     even though a provisional sum's pricing_source is typically
//     'ai_allowance' (same as a pc_allowance) — kept as its own bucket
//     because a provisional sum is contingent-by-definition (margin forced
//     to 0%, see migration 012's trigger), not a considered budget figure
//     the same way a pc_allowance is.
//   - Only after those two checks does pricing_source decide the bucket.
//   - A total that IS populated but whose pricing_source is null or not one
//     of the ten known values (migration 072's CHECK constraint) is real,
//     spendable dollar value with an untraceable origin — reported
//     separately as a data-quality flag, never silently folded into
//     "measured pricing" or any other bucket, since that would be exactly
//     the kind of unverified trust in a label this script exists to avoid.
//
// Categories (mutually exclusive, exactly one per included line item):
//   1. measured_pricing   — cost_rates_exact / cost_rates_normalized /
//                            category_rate / builder_rate / network_rate
//   2. document_pricing    — pricing_source = 'document'
//   3. ai_measured_rates    — pricing_source = 'ai_measured_rate'
//   4. ai_allowances        — pricing_source = 'ai_allowance', pricing_type
//                              != 'provisional_sum'
//   5. provisional_sums     — pricing_type = 'provisional_sum'
//   6. manual_overrides     — pricing_source = 'manual'
//   7. true_unresolved      — total IS NULL
//
// Does NOT implement any fix. Read-only. No pricing/gate/allowance logic
// touched or re-derived — every dollar figure printed here is exactly what
// is already stored on the row.
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node --experimental-strip-types scripts/dev-estimate-composition-report.mjs \
//       --quote-id=<uuid> [--job-id=<uuid>] [--benchmark=2300000]
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { tradeCategoryName, TRADE_CATEGORIES } from '../lib/trade-taxonomy.ts'

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
  console.error('Required: --quote-id=<uuid> [--job-id=<uuid>] [--benchmark=2300000]')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
const quoteId = args['quote-id']
const jobId = args['job-id'] ?? null
const benchmark = args.benchmark ? Number(args.benchmark) : 2_300_000

const money = (n) => `$${Math.round(n ?? 0).toLocaleString('en-AU')}`
const pct = (n) => `${(Math.round((n ?? 0) * 100) / 100).toFixed(2)}%`

const MEASURED_SOURCES = new Set(['cost_rates_exact', 'cost_rates_normalized', 'category_rate', 'builder_rate', 'network_rate'])

// Classification order matters — see header comment. Returns exactly one
// category id per item.
function classify(item) {
  if (item.total === null) return 'true_unresolved'
  if (item.pricing_type === 'provisional_sum') return 'provisional_sums'
  if (item.pricing_source === 'manual') return 'manual_overrides'
  if (item.pricing_source === 'document') return 'document_pricing'
  if (item.pricing_source === 'ai_measured_rate') return 'ai_measured_rates'
  if (item.pricing_source === 'ai_allowance') return 'ai_allowances'
  if (MEASURED_SOURCES.has(item.pricing_source)) return 'measured_pricing'
  // total is non-null but pricing_source doesn't explain it — a real,
  // spendable dollar figure with an untraceable origin. Never silently
  // folded into another bucket.
  return 'unlabeled_priced'
}

const CATEGORY_ORDER = [
  'measured_pricing',
  'document_pricing',
  'ai_measured_rates',
  'ai_allowances',
  'provisional_sums',
  'manual_overrides',
  'true_unresolved',
]

const CATEGORY_LABEL = {
  measured_pricing: 'Measured pricing (exact/normalized rate match, category fallback, builder/network rate)',
  document_pricing: 'Document pricing (supplier/schedule-derived)',
  ai_measured_rates: 'AI measured rates (real quantity, AI-proposed $/unit)',
  ai_allowances: 'AI allowances (judgement-based budget values)',
  provisional_sums: 'Provisional sums (scope TBD, contingent, 0% margin)',
  manual_overrides: 'Manual overrides (builder-entered)',
  true_unresolved: 'True unresolved (total is null after all pricing passes)',
}

function avg(nums) {
  const vals = nums.filter((n) => n !== null && n !== undefined && isFinite(n))
  if (vals.length === 0) return null
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

async function main() {
  const { data: quote, error: quoteErr } = await supabase
    .from('quotes')
    .select('id, job_id, total_cost, confidence_score, price_coverage_pct, pricing_match_rate_pct, allowance_pct')
    .eq('id', quoteId)
    .single()
  if (quoteErr || !quote) throw new Error(`Quote not found: ${quoteErr?.message ?? quoteId}`)

  const effectiveJobId = jobId ?? quote.job_id

  const { data: rawItems, error: itemsErr } = await supabase
    .from('quote_line_items')
    .select('id, trade_category_id, description, quantity, unit, rate, total, confidence, assumption_status, pricing_type, pricing_source, pricing_basis, original_ai_value')
    .eq('quote_id', quoteId)
  if (itemsErr) throw new Error(`Could not load line items: ${itemsErr.message}`)

  const included = (rawItems ?? []).filter((i) => i.assumption_status !== 'excluded')
  const totalCost = quote.total_cost ?? included.reduce((sum, i) => sum + (i.total ?? 0), 0)

  const classified = included.map((i) => ({ ...i, category: classify(i) }))

  const byCategory = new Map()
  for (const cat of [...CATEGORY_ORDER, 'unlabeled_priced']) byCategory.set(cat, [])
  for (const i of classified) byCategory.get(i.category).push(i)

  // ── Console report ──────────────────────────────────────────────────────
  console.log('='.repeat(72))
  console.log('CANONICAL ESTIMATE COMPOSITION REPORT — read-only, no pricing changes made')
  console.log('='.repeat(72))
  console.log(`Quote:              ${quoteId}`)
  console.log(`Job:                ${effectiveJobId ?? '(unknown)'}`)
  console.log(`Estimate total:     ${money(totalCost)}`)
  console.log(`Benchmark:          ${money(benchmark)}`)
  console.log(`Gap:                ${money(benchmark - totalCost)}  (current is ${pct((totalCost / benchmark) * 100)} of benchmark)`)
  console.log(`Included items:     ${included.length}`)
  console.log(`price_coverage_pct:      ${quote.price_coverage_pct}%`)
  console.log(`pricing_match_rate_pct:  ${quote.pricing_match_rate_pct}%`)
  console.log(`allowance_pct:           ${quote.allowance_pct}%`)

  const categoryReport = {}
  for (const cat of CATEGORY_ORDER) {
    const items = byCategory.get(cat)
    const dollarValue = items.reduce((sum, i) => sum + (i.total ?? 0), 0)
    const avgConfidence = avg(items.map((i) => i.confidence))
    const top20 = [...items].sort((a, b) => (b.total ?? 0) - (a.total ?? 0)).slice(0, 20)

    categoryReport[cat] = {
      item_count: items.length,
      dollar_value: Math.round(dollarValue * 100) / 100,
      pct_of_total: totalCost > 0 ? Math.round((dollarValue / totalCost) * 10000) / 100 : 0,
      avg_confidence: avgConfidence === null ? null : Math.round(avgConfidence * 100) / 100,
      top_20: top20.map((i) => ({
        id: i.id,
        trade: tradeCategoryName(i.trade_category_id),
        description: i.description,
        total: i.total,
        confidence: i.confidence,
        pricing_source: i.pricing_source,
        pricing_basis: i.pricing_basis,
      })),
    }

    console.log('\n' + '-'.repeat(72))
    console.log(`${cat.toUpperCase()}  —  ${CATEGORY_LABEL[cat]}`)
    console.log('-'.repeat(72))
    console.log(`item_count:      ${items.length}`)
    console.log(`dollar_value:    ${money(dollarValue)}`)
    console.log(`pct_of_total:    ${pct(categoryReport[cat].pct_of_total)}`)
    console.log(`avg_confidence:  ${avgConfidence === null ? 'n/a' : pct(avgConfidence).replace('%', '') + '%'}`)
    if (top20.length > 0) {
      console.log(`\nTop ${top20.length} by $ value:`)
      for (const i of top20) {
        console.log(`  ${money(i.total ?? 0).padStart(12)}  [${tradeCategoryName(i.trade_category_id)}] ${i.description}  (confidence=${i.confidence ?? 'n/a'}, source=${i.pricing_source ?? 'null'})`)
      }
    }
  }

  // ── Data quality flag: priced but unlabeled ─────────────────────────────
  const unlabeled = byCategory.get('unlabeled_priced')
  const unlabeledValue = unlabeled.reduce((sum, i) => sum + (i.total ?? 0), 0)
  if (unlabeled.length > 0) {
    console.log('\n' + '-'.repeat(72))
    console.log(`DATA QUALITY FLAG — UNLABELED_PRICED  —  ${unlabeled.length} item(s), ${money(unlabeledValue)}`)
    console.log('-'.repeat(72))
    console.log('These items have a non-null total but pricing_source is null or not one of the')
    console.log("ten known values (migration 072) — real dollar value with an untraceable origin.")
    console.log('Not folded into any of the 7 categories above. Signal for finding D) another')
    console.log('generation/pricing-pass issue — a code path is writing total without writing')
    console.log('pricing_source.')
    for (const i of unlabeled.slice(0, 20)) {
      console.log(`  ${money(i.total ?? 0).padStart(12)}  [${tradeCategoryName(i.trade_category_id)}] ${i.description}  (pricing_source=${i.pricing_source ?? 'null'}, pricing_type=${i.pricing_type})`)
    }
  }

  // ── Top 20 largest AI allowances ────────────────────────────────────────
  const allowances = [...byCategory.get('ai_allowances')].sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
  console.log('\n' + '='.repeat(72))
  console.log(`TOP 20 LARGEST AI ALLOWANCES (of ${allowances.length} total)`)
  console.log('='.repeat(72))
  const top20Allowances = allowances.slice(0, 20).map((a) => ({
    trade: tradeCategoryName(a.trade_category_id),
    item: a.description,
    amount: a.total,
    confidence: a.confidence,
    reasoning: a.pricing_basis ?? '(none recorded)',
  }))
  for (const a of top20Allowances) {
    console.log(`\nTrade:      ${a.trade}`)
    console.log(`Item:       ${a.item}`)
    console.log(`Amount:     ${money(a.amount)}`)
    console.log(`Confidence: ${a.confidence ?? 'n/a'}`)
    console.log(`Reasoning:  ${a.reasoning}`)
  }

  // ── Gap analysis ─────────────────────────────────────────────────────────
  // Per-trade breakdown: item count, $ value, avg confidence, and the share
  // of that trade's dollar value coming from ai_allowance/provisional_sum
  // (judgment-based) vs. everything else (measured/document/matched).
  const tradeStats = new Map()
  for (const t of TRADE_CATEGORIES) {
    tradeStats.set(t.id, { trade_category_id: t.id, trade_name: t.name, item_count: 0, dollar_value: 0, judgment_dollar_value: 0, confidences: [] })
  }
  for (const i of classified) {
    const s = tradeStats.get(i.trade_category_id)
    if (!s) continue
    s.item_count += 1
    s.dollar_value += i.total ?? 0
    if (i.category === 'ai_allowances' || i.category === 'provisional_sums') s.judgment_dollar_value += i.total ?? 0
    if (i.confidence !== null && i.confidence !== undefined) s.confidences.push(i.confidence)
  }
  const tradeStatsList = Array.from(tradeStats.values()).map((s) => ({
    trade_category_id: s.trade_category_id,
    trade_name: s.trade_name,
    item_count: s.item_count,
    dollar_value: Math.round(s.dollar_value * 100) / 100,
    judgment_pct_of_trade: s.dollar_value > 0 ? Math.round((s.judgment_dollar_value / s.dollar_value) * 10000) / 100 : 0,
    avg_confidence: avg(s.confidences),
  }))

  // Signal, not verdict: a scoped trade (per scope_items) that ended up with
  // very few line items relative to the rest of this quote's own trades is
  // a "thin scope" candidate — worth a human look, never asserted as fact.
  let scopeRows = []
  if (effectiveJobId) {
    const { data } = await supabase.from('scope_items').select('trade_category_id, included_scope').eq('job_id', effectiveJobId)
    scopeRows = data ?? []
  }
  const scopedTradeIds = new Set(scopeRows.filter((s) => s.included_scope?.length > 0).map((s) => s.trade_category_id))
  const nonZeroTradeCounts = tradeStatsList.filter((t) => t.item_count > 0).map((t) => t.item_count)
  const medianItemCount = nonZeroTradeCounts.length > 0
    ? [...nonZeroTradeCounts].sort((a, b) => a - b)[Math.floor(nonZeroTradeCounts.length / 2)]
    : 0
  const thinScopeThreshold = Math.max(2, Math.round(medianItemCount * 0.25))

  const likelyMissingScope = tradeStatsList.filter((t) => scopedTradeIds.has(t.trade_category_id) && t.item_count > 0 && t.item_count <= thinScopeThreshold)
  const missingTradesEntirely = Array.from(scopedTradeIds).filter((id) => !tradeStatsList.some((t) => t.trade_category_id === id && t.item_count > 0))

  const likelyAllowanceUnderestimation = tradeStatsList
    .filter((t) => t.dollar_value > 0 && t.judgment_pct_of_trade >= 60)
    .sort((a, b) => b.dollar_value * (b.judgment_pct_of_trade / 100) - a.dollar_value * (a.judgment_pct_of_trade / 100))

  const gap = benchmark - totalCost
  const gapPct = benchmark > 0 ? (gap / benchmark) * 100 : 0

  console.log('\n' + '='.repeat(72))
  console.log('GAP ANALYSIS vs. BENCHMARK')
  console.log('='.repeat(72))
  console.log(`Estimate total:  ${money(totalCost)}`)
  console.log(`Benchmark:       ${money(benchmark)}`)
  console.log(`Gap:             ${money(gap)}  (${pct(gapPct)} of benchmark)`)

  console.log('\n--- Likely missing scope ---')
  if (missingTradesEntirely.length > 0) {
    console.log(`${missingTradesEntirely.length} scoped trade(s) with ZERO line items:`)
    for (const id of missingTradesEntirely) console.log(`  - ${tradeCategoryName(id)}`)
  } else {
    console.log('No scoped trade currently has zero line items.')
  }
  if (likelyMissingScope.length > 0) {
    console.log(`\n${likelyMissingScope.length} trade(s) with unusually few items relative to this quote's own median (${medianItemCount}) — "thin scope" candidates, not confirmed gaps:`)
    for (const t of likelyMissingScope) console.log(`  - ${t.trade_name}: ${t.item_count} item(s), ${money(t.dollar_value)}`)
  }

  console.log('\n--- Likely allowance underestimation ---')
  if (likelyAllowanceUnderestimation.length > 0) {
    console.log('Trades where >=60% of dollar value is judgment-based (ai_allowance/provisional_sum), ranked by judgment $ exposure:')
    for (const t of likelyAllowanceUnderestimation) {
      console.log(`  - ${t.trade_name}: ${money(t.dollar_value)} total, ${pct(t.judgment_pct_of_trade)} judgment-based, avg confidence ${t.avg_confidence === null ? 'n/a' : Math.round(t.avg_confidence)}`)
    }
  } else {
    console.log('No trade currently has >=60% of its dollar value from judgment-based pricing.')
  }

  console.log('\n--- Possible benchmark differences ---')
  console.log('This script cannot independently confirm what the benchmark figure includes')
  console.log('(margin, GST, contingency, a different scope basis, or a different pricing date).')
  console.log(`Current quote margin/GST treatment: total_cost is WorkA's internal COST basis`)
  console.log('(see CLAUDE.md "Margin rule") — if the benchmark figure is a client-facing/sell')
  console.log('price, part of this gap is not a pricing gap at all but a cost-vs-sell-price')
  console.log('comparison error. Reconcile the benchmark\'s own basis before treating the full')
  console.log(`${money(gap)} gap as evidence of underpricing.`)

  // ── Verdict signals (not a verdict) ─────────────────────────────────────
  console.log('\n' + '='.repeat(72))
  console.log('SIGNALS FOR NEXT-STEP PRIORITIZATION (not a recommendation — for human read)')
  console.log('='.repeat(72))
  console.log(`A) Bunnings/material pricing:      measured_pricing dollar share = ${pct(categoryReport.measured_pricing.pct_of_total)}, avg_confidence = ${categoryReport.measured_pricing.avg_confidence ?? 'n/a'}`)
  console.log(`B) Allowance calibration:           ai_allowances + provisional_sums combined = ${pct(categoryReport.ai_allowances.pct_of_total + categoryReport.provisional_sums.pct_of_total)} of total, ${likelyAllowanceUnderestimation.length} trade(s) >=60% judgment-based`)
  console.log(`C) Benchmark scope alignment:        ${missingTradesEntirely.length} trade(s) entirely missing, ${likelyMissingScope.length} thin-scope candidate(s) — see caveat on benchmark basis above`)
  console.log(`D) Another generation issue:         ${unlabeled.length} unlabeled_priced item(s) worth ${money(unlabeledValue)}, ${categoryReport.true_unresolved.item_count} true_unresolved item(s)`)

  console.log('\n' + '='.repeat(72))
  console.log(JSON.stringify({
    event: 'estimate_composition_report_complete',
    quote_id: quoteId,
    job_id: effectiveJobId,
    estimate_total: totalCost,
    benchmark,
    gap,
    gap_pct: Math.round(gapPct * 100) / 100,
    categories: categoryReport,
    unlabeled_priced: { item_count: unlabeled.length, dollar_value: Math.round(unlabeledValue * 100) / 100 },
    top_20_allowances: top20Allowances,
    trade_breakdown: tradeStatsList,
    gap_analysis: {
      missing_trades_entirely: missingTradesEntirely.map((id) => ({ trade_category_id: id, trade_name: tradeCategoryName(id) })),
      likely_missing_scope_thin: likelyMissingScope,
      likely_allowance_underestimation: likelyAllowanceUnderestimation,
    },
  }, null, 2))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'estimate_composition_report_failed', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
