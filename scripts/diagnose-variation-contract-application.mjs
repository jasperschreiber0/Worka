#!/usr/bin/env node
// ============================================================
// Diagnostic only, NOT part of any milestone — read-only, platform-wide
// production check for the variation-approval persistence-truthfulness fix
// (Round 5 reliability audit finding).
//
// Looks for the exact gap this fix makes observable (and, via the new
// retry-contract-application route, repairable): a variation whose status
// is 'approved' but which has no corresponding quote_line_items row —
// meaning applyApprovedVariationToQuote either never ran to completion or
// genuinely failed, and (before this fix) nothing ever logged or surfaced
// that.
//
// Read-only. Modifies nothing.
//
// Usage: node scripts/diagnose-variation-contract-application.mjs
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

  const { data: approved, error: approvedErr } = await supabase
    .from('variations')
    .select('id, job_id, builder_id, title, amount, trade_category_id, approved_at')
    .eq('status', 'approved')

  if (approvedErr) {
    console.error(JSON.stringify({ event: 'variations_query_failed', error: approvedErr.message }))
    process.exit(1)
  }

  const rows = approved ?? []
  console.log(JSON.stringify({ event: 'approved_variations_count', count: rows.length }))

  if (rows.length === 0) {
    console.log(JSON.stringify({ event: 'run_complete', unapplied_count: 0 }))
    return
  }

  const variationIds = rows.map((r) => r.id)
  const appliedIds = new Set()
  const CHUNK = 200
  for (let i = 0; i < variationIds.length; i += CHUNK) {
    const chunk = variationIds.slice(i, i + CHUNK)
    const { data: lineItems, error: liErr } = await supabase
      .from('quote_line_items')
      .select('variation_id')
      .in('variation_id', chunk)
    if (liErr) {
      console.error(JSON.stringify({ event: 'quote_line_items_query_failed', error: liErr.message }))
      process.exit(1)
    }
    for (const li of lineItems ?? []) appliedIds.add(li.variation_id)
  }

  const unapplied = rows.filter((r) => !appliedIds.has(r.id))

  console.log(JSON.stringify({
    event: 'unapplied_approved_variations',
    description: 'variations.status=approved with no matching quote_line_items.variation_id -- the contract-application gap this fix makes observable/repairable',
    count: unapplied.length,
    rows: unapplied.slice(0, 50),
    truncated: unapplied.length > 50,
  }))

  console.log(JSON.stringify({ event: 'run_complete', unapplied_count: unapplied.length }))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
