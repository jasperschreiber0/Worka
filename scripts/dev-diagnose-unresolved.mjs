#!/usr/bin/env node
// ============================================================
// WorkA — dev-mode: diagnose unresolved quote line items
// ============================================================
// PURPOSE: visibility only — this script does not price, allowance, gate,
// or otherwise modify anything. It reads every currently-unresolved line
// item on a quote (pricing_source = 'unresolved', i.e. total is still null
// and nothing has priced it at any tier) and classifies each into exactly
// one of three categories using the pure, unit-tested classifier in
// lib/estimating/unresolved-diagnostics.ts:
//
//   A. measured_pricing_failure — quantity AND unit are both present
//      (Stage 6 measured this scope); whatever failed, failed at PRICING.
//   B. allowance_candidate      — no usable quantity/unit, but Stage 6
//      already flagged it pc_allowance/provisional_sum; scope is
//      understood, only a dollar figure is missing.
//   C. true_unresolved          — neither of the above; genuinely
//      insufficient information to responsibly estimate.
//
// "current_value_impact" is always $0 for every category — that's not a
// bug, it's the honest answer: every item in this report contributes
// nothing to the quote today. Where a rough SENSE of scale is useful, this
// script additionally prints an "illustrative_only" comparison (average
// priced item value in the same trade), clearly labelled as such and never
// folded into the totals — the same pattern scripts/dev-audit-gap.mjs
// already established for its own illustrative-only missing-trade figure.
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node --experimental-strip-types scripts/dev-diagnose-unresolved.mjs \
//       --quote-id=<uuid>
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { tradeCategoryName } from '../lib/trade-taxonomy.ts'
import {
  classifyUnresolvedItems,
  buildUnresolvedDiagnosticsReport,
} from '../lib/estimating/unresolved-diagnostics.ts'

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
const money = (n) => `$${Math.round(n).toLocaleString('en-AU')}`

async function main() {
  const { data: items, error: itemsErr } = await supabase
    .from('quote_line_items')
    .select('id, trade_category_id, description, quantity, unit, pricing_type, assumption_status, pricing_source')
    .eq('quote_id', quoteId)
    .eq('pricing_source', 'unresolved')
  if (itemsErr) throw new Error(`Could not load line items: ${itemsErr.message}`)
  const unresolvedItems = items ?? []

  const lineItemIds = unresolvedItems.map((i) => i.id)
  const { data: assumptionRows } = lineItemIds.length > 0
    ? await supabase.from('assumptions').select('line_item_id, gate, description').in('line_item_id', lineItemIds)
    : { data: [] }
  const assumptionByLineItemId = new Map((assumptionRows ?? []).map((a) => [a.line_item_id, a]))

  const inputs = unresolvedItems.map((i) => {
    const assumption = assumptionByLineItemId.get(i.id)
    return {
      id: i.id,
      description: i.description,
      trade_category_id: i.trade_category_id,
      quantity: i.quantity,
      unit: i.unit,
      pricing_type: i.pricing_type,
      gate: assumption?.gate ?? null,
      gate_message: assumption?.description ?? null,
    }
  })
  const classified = classifyUnresolvedItems(inputs)
  const report = buildUnresolvedDiagnosticsReport(classified)

  // Illustrative-only comparison value per category, same "clearly labelled,
  // never folded into a real total" pattern dev-audit-gap.mjs uses — the
  // average total$ of PRICED items in the same trade(s) these unresolved
  // items sit in, purely to give a rough sense of scale.
  const { data: pricedItems } = await supabase
    .from('quote_line_items')
    .select('trade_category_id, total')
    .eq('quote_id', quoteId)
    .not('total', 'is', null)
  const avgByTrade = new Map()
  for (const p of pricedItems ?? []) {
    const arr = avgByTrade.get(p.trade_category_id) ?? []
    arr.push(p.total)
    avgByTrade.set(p.trade_category_id, arr)
  }
  const illustrativeAvg = (tradeId) => {
    const arr = avgByTrade.get(tradeId)
    if (!arr || arr.length === 0) return null
    return arr.reduce((a, b) => a + b, 0) / arr.length
  }

  console.log('='.repeat(72))
  console.log('UNRESOLVED LINE ITEM DIAGNOSTIC — read-only, no pricing/gate changes made')
  console.log('='.repeat(72))
  console.log(`Quote:            ${quoteId}`)
  console.log(`Total unresolved: ${report.total_items}`)

  for (const c of report.categories) {
    console.log('\n' + '-'.repeat(72))
    console.log(`${c.category.toUpperCase()}  —  ${c.item_count} item${c.item_count === 1 ? '' : 's'}`)
    console.log('-'.repeat(72))
    console.log(`current_value_impact: ${money(c.current_value_impact)} (every unresolved item is $0 today, by definition)`)
    const categoryItems = classified.filter((i) => i.category === c.category)
    const illustrativeTotal = categoryItems.reduce((sum, i) => sum + (illustrativeAvg(i.trade_category_id) ?? 0), 0)
    console.log(`illustrative_only_comparison: ~${money(illustrativeTotal)} (avg priced-item $ in same trade × item count — NOT a real estimate, never added to any total)`)
    console.log(`recommended_next_action: ${c.recommended_next_action}`)
    if (categoryItems.length > 0) {
      console.log(`\nAll ${categoryItems.length} item(s):`)
      for (const i of categoryItems) {
        console.log(`  [${i.id}] ${tradeCategoryName(i.trade_category_id)} — "${i.description}"`)
        console.log(`      quantity=${i.quantity ?? 'null'} unit=${i.unit ?? 'null'} pricing_type=${i.pricing_type ?? 'null'}`)
        console.log(`      gate=${i.gate ?? 'null'} reason=${i.gate_message ?? '(no assumption row found)'}`)
        console.log(`      has_enough_information_to_price=${i.has_enough_information}`)
      }
    }
  }

  console.log('\n' + '='.repeat(72))
  console.log(JSON.stringify({ event: 'diagnose_unresolved_complete', quote_id: quoteId, ...report }, null, 2))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'diagnose_unresolved_failed', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
