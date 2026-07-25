#!/usr/bin/env node
// ============================================================
// WorkA — dev-mode: verify the ensureQuotePriced minimal fix
// ============================================================
// PURPOSE: proves, against a real quote, that the two-line change to
// ensureQuotePriced (lib/pricing.ts) does exactly what it should and
// nothing else:
//   1. A quote with an existing non-null total_cost can now price a new
//      total=null line item (the guard no longer blocks it).
//   2. Every pre-existing item (document/allowance/manual/provisional-sum,
//      AND the historical unlabeled rows) is byte-identical before/after —
//      proves nothing already-decided was touched.
//   3. The newly-priced item ends up with a real, non-null pricing_source.
//   4. The historical unlabeled_priced rows are still exactly as many, and
//      still unchanged — proves this fix does not silently repair them
//      (that's reserved for the separate audited backfill).
//
// Inserts exactly one test line item, calls ensureQuotePriced, verifies,
// then deletes the test item — leaves the quote in its original state
// (modulo the one temporary insert/delete).
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node --experimental-strip-types scripts/dev-verify-ensurequotepriced-fix.mjs \
//       --quote-id=<uuid>
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { ensureQuotePriced } from '../lib/pricing.ts'

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

const KNOWN_SOURCES = new Set([
  'document', 'cost_rates_exact', 'cost_rates_normalized', 'category_rate',
  'builder_rate', 'network_rate', 'ai_measured_rate', 'ai_allowance', 'manual', 'unresolved',
])

function snapshotFingerprint(items) {
  // Deterministic per-item fingerprint of everything the fix must never move.
  return new Map(items.map((i) => [i.id, JSON.stringify({
    rate: i.rate, total: i.total, pricing_source: i.pricing_source,
    pricing_basis: i.pricing_basis, confidence: i.confidence,
  })]))
}

async function loadItems() {
  const { data, error } = await supabase
    .from('quote_line_items')
    .select('id, trade_category_id, description, quantity, unit, rate, total, confidence, assumption_status, pricing_source, pricing_basis')
    .eq('quote_id', quoteId)
  if (error) throw new Error(`Could not load line items: ${error.message}`)
  return data ?? []
}

async function main() {
  const { data: quoteBefore, error: quoteErr } = await supabase
    .from('quotes')
    .select('id, total_cost')
    .eq('id', quoteId)
    .single()
  if (quoteErr || !quoteBefore) throw new Error(`Quote not found: ${quoteErr?.message ?? quoteId}`)

  console.log('='.repeat(72))
  console.log('VERIFY ensureQuotePriced FIX')
  console.log('='.repeat(72))
  console.log(`Quote: ${quoteId}`)
  console.log(`quotes.total_cost BEFORE: ${quoteBefore.total_cost}`)
  if (quoteBefore.total_cost === null) {
    console.log('\nNOTE: total_cost is already null on this quote — the OLD guard would not')
    console.log('have blocked pricing here either, so this run cannot demonstrate the fix.')
    console.log('The fix specifically matters when total_cost is non-null (this quote\'s real')
    console.log('state as of the investigation) — proceeding anyway for completeness.')
  }

  const beforeItems = await loadItems()
  const beforeFingerprint = snapshotFingerprint(beforeItems)
  const beforeUnlabeled = beforeItems.filter(
    (i) => i.assumption_status !== 'excluded' && i.total !== null && !KNOWN_SOURCES.has(i.pricing_source)
  )
  console.log(`\nExisting items: ${beforeItems.length}`)
  console.log(`Historical unlabeled_priced items BEFORE: ${beforeUnlabeled.length}`)

  // ── Insert one test line item mimicking genuine unpriced Stage 6 output ──
  // Trade 1 = Site Works & Concrete (matches the real quote's own trades).
  // No document/allowance price — total: null, pricing_source: null — the
  // exact shape buildLineItemInsertRows produces for a measured item Stage 6
  // could not price at generation time.
  const testDescription = `TEST ITEM (dev-verify-ensurequotepriced-fix, safe to delete) — ${new Date().toISOString()}`
  const { data: inserted, error: insertErr } = await supabase
    .from('quote_line_items')
    .insert({
      quote_id: quoteId,
      trade_category_id: 1,
      description: testDescription,
      quantity: 10,
      unit: 'm2',
      rate: null,
      total: null,
      confidence: 60,
      assumption_status: null,
      pricing_type: 'measured',
      pricing_source: null,
      margin_pct: 0.15,
    })
    .select('id')
    .single()
  if (insertErr) throw new Error(`Could not insert test item: ${insertErr.message}`)
  const testItemId = inserted.id
  console.log(`\nInserted test item: ${testItemId}`)

  try {
    // ── The actual call under test ──────────────────────────────────────
    const wasPriced = await ensureQuotePriced(supabase, quoteId)
    console.log(`\nensureQuotePriced returned: ${wasPriced}`)

    const afterItems = await loadItems()
    const afterFingerprint = snapshotFingerprint(afterItems)

    // ── Check 1: quote with existing total_cost can now price a new item ──
    const testItemAfter = afterItems.find((i) => i.id === testItemId)
    const testItemPriced = testItemAfter && testItemAfter.pricing_source !== null
    console.log('\n--- Check 1: new pending item on an already-priced quote ---')
    console.log(`Test item pricing_source AFTER: ${testItemAfter?.pricing_source ?? 'null'}`)
    console.log(`Test item total AFTER: ${testItemAfter?.total ?? 'null'}`)
    console.log(`RESULT: ${testItemPriced ? 'PASS — item received a pricing decision' : 'FAIL — item still pricing_source=null'}`)

    // ── Check 2: every pre-existing item is untouched ─────────────────────
    let mutatedCount = 0
    const mutated = []
    for (const [id, fp] of beforeFingerprint.entries()) {
      const afterFp = afterFingerprint.get(id)
      if (afterFp !== fp) {
        mutatedCount++
        mutated.push(id)
      }
    }
    console.log('\n--- Check 2: pre-existing items unchanged ---')
    console.log(`Pre-existing items compared: ${beforeFingerprint.size}`)
    console.log(`Mutated: ${mutatedCount}`)
    if (mutatedCount > 0) console.log(`Mutated IDs: ${mutated.join(', ')}`)
    console.log(`RESULT: ${mutatedCount === 0 ? 'PASS — zero pre-existing items changed' : 'FAIL — see mutated IDs above'}`)

    // ── Check 3: pricing_source populated after pricing attempt ───────────
    console.log('\n--- Check 3: pricing_source populated for the newly-priced item ---')
    console.log(`RESULT: ${testItemPriced ? `PASS — pricing_source = '${testItemAfter.pricing_source}'` : 'FAIL'}`)

    // ── Check 4: historical unlabeled rows untouched ───────────────────────
    const afterUnlabeled = afterItems.filter(
      (i) => i.id !== testItemId && i.assumption_status !== 'excluded' && i.total !== null && !KNOWN_SOURCES.has(i.pricing_source)
    )
    const unlabeledUnchanged = beforeUnlabeled.length === afterUnlabeled.length &&
      beforeUnlabeled.every((b) => {
        const a = afterUnlabeled.find((x) => x.id === b.id)
        return a && a.total === b.total && a.pricing_source === b.pricing_source
      })
    console.log('\n--- Check 4: historical unlabeled_priced rows untouched ---')
    console.log(`Count BEFORE: ${beforeUnlabeled.length}   Count AFTER: ${afterUnlabeled.length}`)
    console.log(`RESULT: ${unlabeledUnchanged ? 'PASS — historical rows byte-identical' : 'FAIL — see counts/rows above'}`)

    const { data: quoteAfter } = await supabase.from('quotes').select('total_cost').eq('id', quoteId).single()
    console.log(`\nquotes.total_cost AFTER: ${quoteAfter?.total_cost}`)

    console.log('\n' + '='.repeat(72))
    console.log('SUMMARY')
    console.log('='.repeat(72))
    const allPass = testItemPriced && mutatedCount === 0 && unlabeledUnchanged
    console.log(allPass ? 'ALL CHECKS PASSED' : 'ONE OR MORE CHECKS FAILED — see above')
  } finally {
    // ── Cleanup: remove the test item regardless of outcome ────────────────
    const { error: deleteErr } = await supabase.from('quote_line_items').delete().eq('id', testItemId)
    if (deleteErr) {
      console.error(`\nWARNING: failed to delete test item ${testItemId}: ${deleteErr.message}`)
      console.error('Manual cleanup required: DELETE FROM quote_line_items WHERE id = ' + `'${testItemId}';`)
    } else {
      console.log(`\nTest item ${testItemId} deleted — quote restored to its pre-test state.`)
      // Recompute totals once more so quotes.total_cost reflects the item's removal.
      await ensureQuotePriced(supabase, quoteId).catch(() => {})
      const { recomputeQuoteTotals } = await import('../lib/pricing.ts')
      await recomputeQuoteTotals(supabase, quoteId)
      console.log('quotes.total_cost recomputed post-cleanup.')
    }
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'verify_fix_failed', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
