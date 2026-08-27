#!/usr/bin/env node
// ============================================================
// Diagnostic only, NOT part of any milestone — read-only, platform-wide
// production check for the assumptions-resolve persistence-truthfulness fix
// (Round 4 reliability audit finding, POST /api/assumptions/[quoteId]/resolve).
//
// Looks for the exact inconsistency the fix closes: an assumption whose
// resolution_type says it was resolved (accepted/adjusted/excluded), but
// its linked quote_line_items row's assumption_status does not match —
// meaning the dependent quote_line_items write silently failed under the
// PRE-FIX code, which wrote assumptions.resolution_type FIRST with no
// ordering guarantee that quote_line_items was ever actually updated.
//
// Every apparent mismatch is reported, but NOT every mismatch is
// necessarily a bug: quote_line_items.assumption_status can legitimately
// be overwritten by a LATER document reclassification/re-estimate pass
// unrelated to this route (e.g. an incremental upload merging new facts).
// This script reports counts/IDs for human review — it does not attempt to
// distinguish "genuinely inconsistent" from "legitimately since-changed"
// beyond what's stated here, and it modifies nothing.
//
// Usage: node scripts/diagnose-assumption-resolution-truthfulness.mjs
// ============================================================

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY must be set' }))
  process.exit(1)
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: resolved, error: resolvedErr } = await supabase
    .from('assumptions')
    .select('id, quote_id, line_item_id, resolution_type, resolved_at')
    .not('resolution_type', 'is', null)
    .not('line_item_id', 'is', null)

  if (resolvedErr) {
    console.error(JSON.stringify({ event: 'assumptions_query_failed', error: resolvedErr.message }))
    process.exit(1)
  }

  const rows = resolved ?? []
  console.log(JSON.stringify({ event: 'resolved_assumptions_with_line_item_count', count: rows.length }))

  if (rows.length === 0) {
    console.log(JSON.stringify({ event: 'run_complete', mismatches_found: 0, quotes_affected: 0 }))
    return
  }

  const lineItemIds = Array.from(new Set(rows.map((r) => r.line_item_id)))
  const lineItemsById = {}
  const CHUNK = 200
  for (let i = 0; i < lineItemIds.length; i += CHUNK) {
    const chunk = lineItemIds.slice(i, i + CHUNK)
    const { data: items, error: itemsErr } = await supabase
      .from('quote_line_items')
      .select('id, quote_id, assumption_status, is_assumption, quantity, unit, total, rate')
      .in('id', chunk)
    if (itemsErr) {
      console.error(JSON.stringify({ event: 'quote_line_items_query_failed', error: itemsErr.message }))
      process.exit(1)
    }
    for (const item of items ?? []) lineItemsById[item.id] = item
  }

  const mismatches = []
  for (const row of rows) {
    const li = lineItemsById[row.line_item_id]
    if (!li) {
      // The line item itself no longer exists (e.g. a quote revise copied
      // items to a new quote and this assumption still points at the old
      // one) — worth surfacing separately, not the same failure mode.
      mismatches.push({ kind: 'line_item_missing', assumption_id: row.id, quote_id: row.quote_id, line_item_id: row.line_item_id, resolution_type: row.resolution_type })
      continue
    }
    const expectedStatus = row.resolution_type
    const statusMatches = li.assumption_status === expectedStatus
    const excludedFlagOk = expectedStatus !== 'excluded' || li.is_assumption === true
    if (!statusMatches || !excludedFlagOk) {
      mismatches.push({
        kind: 'assumption_status_mismatch',
        assumption_id: row.id, quote_id: row.quote_id, line_item_id: row.line_item_id,
        assumption_resolution_type: row.resolution_type, resolved_at: row.resolved_at,
        line_item_assumption_status: li.assumption_status, line_item_is_assumption: li.is_assumption,
        line_item_quantity: li.quantity, line_item_unit: li.unit, line_item_total: li.total, line_item_rate: li.rate,
      })
    }
  }

  const affectedQuoteIds = Array.from(new Set(mismatches.map((m) => m.quote_id)))

  console.log(JSON.stringify({
    event: 'mismatches_found',
    description: 'assumptions.resolution_type set but linked quote_line_items.assumption_status does not match (or is_assumption not set for an excluded resolution) — the exact defect this fix targets. Human review required: a mismatch can also arise from a legitimate later reclassification unrelated to this route.',
    count: mismatches.length,
    quotes_affected: affectedQuoteIds.length,
    rows: mismatches.slice(0, 50),
    truncated: mismatches.length > 50,
  }))

  if (affectedQuoteIds.length > 0) {
    const { data: quotes } = await supabase
      .from('quotes')
      .select('id, status, total_cost, job_id')
      .in('id', affectedQuoteIds.slice(0, 50))
    console.log(JSON.stringify({ event: 'affected_quotes_state', quotes: quotes ?? [] }))
  }

  console.log(JSON.stringify({ event: 'run_complete', mismatches_found: mismatches.length, quotes_affected: affectedQuoteIds.length }))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
