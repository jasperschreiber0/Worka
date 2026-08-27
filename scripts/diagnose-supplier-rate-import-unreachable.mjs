#!/usr/bin/env node
// ============================================================
// Diagnostic only, NOT part of any milestone — read-only, platform-wide
// production check for the supplier-rate-import persistence-truthfulness
// defect (Round 10 reliability audit finding).
//
// resolveRateForKey's Tier 3 (lib/pricing.ts) only ever matches a
// builder_supplier_rates row by EXACT line_item_key equality against a key
// drawn from loadPricingCatalogue (cost_rates + market_material_prices).
// Any builder_supplier_rates.line_item_key that isn't itself a key present
// in that same catalogue is structurally unreachable by pricing, no matter
// how the import got there. This reports the current count of such rows —
// it does NOT modify or repair anything.
//
// Usage: node scripts/diagnose-supplier-rate-import-unreachable.mjs
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

  const { data: supplierRows, error: supplierErr } = await supabase
    .from('builder_supplier_rates')
    .select('id, builder_id, supplier_name, line_item_key, rate, unit, imported_at')

  if (supplierErr) {
    console.error(JSON.stringify({ event: 'builder_supplier_rates_query_failed', error: supplierErr.message }))
    process.exit(1)
  }

  const rows = supplierRows ?? []
  console.log(JSON.stringify({ event: 'total_supplier_rate_rows', count: rows.length }))

  if (rows.length === 0) {
    console.log(JSON.stringify({ event: 'run_complete', unreachable_count: 0 }))
    return
  }

  const [{ data: costRateKeys, error: costErr }, { data: retailKeys, error: retailErr }] = await Promise.all([
    supabase.from('cost_rates').select('line_item_key'),
    supabase.from('market_material_prices').select('line_item_key'),
  ])

  if (costErr || retailErr) {
    console.error(JSON.stringify({ event: 'catalogue_query_failed', cost_error: costErr?.message, retail_error: retailErr?.message }))
    process.exit(1)
  }

  const catalogueKeys = new Set([
    ...(costRateKeys ?? []).map((r) => r.line_item_key),
    ...(retailKeys ?? []).map((r) => r.line_item_key),
  ])
  console.log(JSON.stringify({ event: 'catalogue_key_count', count: catalogueKeys.size }))

  const unreachable = rows.filter((r) => !catalogueKeys.has(r.line_item_key))
  const reachable = rows.length - unreachable.length

  console.log(JSON.stringify({ event: 'reachable_count', count: reachable }))
  console.log(JSON.stringify({ event: 'unreachable_count', count: unreachable.length }))

  const byBuilderSupplier = new Map()
  for (const r of unreachable) {
    const key = `${r.builder_id}::${r.supplier_name}`
    byBuilderSupplier.set(key, (byBuilderSupplier.get(key) ?? 0) + 1)
  }

  console.log(JSON.stringify({
    event: 'unreachable_breakdown_by_builder_supplier',
    breakdown: Array.from(byBuilderSupplier.entries()).map(([key, count]) => {
      const [builder_id, supplier_name] = key.split('::')
      return { builder_id, supplier_name, count }
    }),
  }))

  console.log(JSON.stringify({
    event: 'unreachable_sample',
    rows: unreachable.slice(0, 20).map((r) => ({ id: r.id, builder_id: r.builder_id, supplier_name: r.supplier_name, line_item_key: r.line_item_key })),
    truncated: unreachable.length > 20,
  }))

  console.log(JSON.stringify({ event: 'run_complete', total: rows.length, reachable, unreachable_count: unreachable.length }))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
