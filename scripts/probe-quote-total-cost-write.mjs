#!/usr/bin/env node
// ============================================================
// WorkA — one-off, read-then-write probe: can quotes.total_cost be
// written at all for a specific quote row? Isolates whether ensureQuotePriced
// never reaches its own quotes.update() call (an application-level bug) vs
// that write failing at the database level (a constraint/trigger/RLS issue
// independent of application code).
// ============================================================
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... QUOTE_ID=... \
//   node scripts/probe-quote-total-cost-write.mjs
// ============================================================

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const QUOTE_ID = process.env.QUOTE_ID

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !QUOTE_ID) {
    log('config_error', { message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, QUOTE_ID required' })
    process.exit(1)
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: before, error: beforeErr } = await supabase
    .from('quotes')
    .select('id, total_cost, margin_pct, confidence_score, price_coverage_pct, pricing_match_rate_pct, allowance_pct')
    .eq('id', QUOTE_ID)
    .single()
  log('before_state', { quote: before ?? null, error: beforeErr?.message ?? null })

  const resetToNull = process.env.RESET_TO_NULL === 'true'
  const probeValue = resetToNull ? null : 12345.67
  const { data: updateData, error: updateErr, status, statusText } = await supabase
    .from('quotes')
    .update(resetToNull
      ? { total_cost: null, confidence_score: null, price_coverage_pct: null, pricing_match_rate_pct: null, allowance_pct: null, margin_pct: null }
      : { total_cost: probeValue, confidence_score: 42, price_coverage_pct: 50, pricing_match_rate_pct: 50, allowance_pct: 10, margin_pct: 0.15 })
    .eq('id', QUOTE_ID)
    .select('id, total_cost, margin_pct, confidence_score')

  log('probe_update_result', {
    error: updateErr?.message ?? null, error_details: updateErr?.details ?? null, error_hint: updateErr?.hint ?? null,
    error_code: updateErr?.code ?? null, status, statusText, returned_rows: updateData ?? null,
  })

  const { data: after, error: afterErr } = await supabase
    .from('quotes')
    .select('id, total_cost, margin_pct, confidence_score')
    .eq('id', QUOTE_ID)
    .single()
  log('after_state', { quote: after ?? null, error: afterErr?.message ?? null })

  // Root-cause check for the ACTUAL app bug (not the probe write, which just
  // proved the DB path works): computeQuoteTotals sums every included item's
  // `total` via reduce -- one non-finite value (NaN/Infinity, from a
  // malformed quantity*rate) poisons the whole sum, and JSON.stringify(NaN)
  // silently becomes `null` on the wire, so the write "succeeds" with no
  // error while writing null. Scan every line item's total/quantity/rate for
  // exactly this.
  const { data: items, error: itemsErr } = await supabase
    .from('quote_line_items')
    .select('id, description, quantity, rate, total, assumption_status')
    .eq('quote_id', QUOTE_ID)
  const suspects = (items ?? []).filter((i) => {
    const t = i.total
    return t !== null && (typeof t !== 'number' || !Number.isFinite(t))
  })
  log('line_item_total_scan', {
    error: itemsErr?.message ?? null,
    total_items: (items ?? []).length,
    null_total_count: (items ?? []).filter((i) => i.total === null).length,
    non_finite_total_count: suspects.length,
    non_finite_examples: suspects.slice(0, 10),
  })

  process.exit(0)
}

main()
