#!/usr/bin/env node
// ============================================================
// Production E2E for the supplier-rate-import persistence-truthfulness fix
// (Round 10 reliability audit finding). Not part of any milestone.
//
// Drives the real, deployed POST /api/rates/import route and the real,
// deployed GET /api/quotes/[quoteId] route (which lazily triggers
// ensureQuotePriced -> priceLineItems -> resolveRateForKey), then
// independently queries the DB at every step rather than trusting API
// responses alone.
//
//   1. Import a supplier rate for "Concrete slab on ground" (trade 1,
//      unit m2) -- a description that genuinely matches the real
//      catalogue's `site_slab` entry -- alongside one deliberately
//      unmatched description in the same batch.
//   2. Independently verify: exactly one builder_supplier_rates row was
//      created, its line_item_key is EXACTLY 'site_slab' (never a
//      description-derived key), and the unmatched row was reported back
//      by the route, not silently persisted.
//   3. Price a real, unpriced quote_line_item with that same description
//      via the real GET /api/quotes/[quoteId] route (its existing lazy
//      ensureQuotePriced backfill) and independently verify
//      pricing_source='supplier' and the resolved rate/total reflect the
//      imported price, not the platform default.
//   4. Re-import the same supplier with a CHANGED price for the same
//      description and independently verify: no duplicate
//      builder_supplier_rates row, the existing row's rate was updated,
//      and a second unpriced line item with the same description then
//      prices at the UPDATED rate.
//
// Cleans up all synthetic rows in a finally block.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL

// Every single-byte 00...00f0-ff suffix and 0001f0 are already reserved by
// other E2E scripts in this session's ledger; this uses the next free id.
const BUILDER_ID = '00000000-0000-0000-0000-0000000001f1'

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL must be set' }))
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

const authHeaders = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'x-worka-builder-id': BUILDER_ID,
}

const SUPPLIER_NAME = 'E2E Concrete Supplies'
const MATCHED_DESCRIPTION = 'Concrete slab on ground'
const UNMATCHED_DESCRIPTION = 'Bespoke ornamental gate hinges xyz789'

let jobId = null
let quoteId = null
const lineItemIds = []

async function cleanup() {
  try {
    await supabase.from('builder_supplier_rates').delete().eq('builder_id', BUILDER_ID).eq('supplier_name', SUPPLIER_NAME)
    if (lineItemIds.length > 0) await supabase.from('quote_line_items').delete().in('id', lineItemIds)
    if (quoteId) await supabase.from('quotes').delete().eq('id', quoteId)
    if (jobId) await supabase.from('jobs').delete().eq('id', jobId)
    log('cleanup_done', { job_id: jobId, quote_id: quoteId, line_item_ids: lineItemIds })
  } catch (err) {
    log('cleanup_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

async function main() {
  let passed = true
  const failures = []

  await supabase.from('builders').upsert(
    { id: BUILDER_ID, email: 'supplier-rate-import-e2e@getworka.com', name: 'Supplier Rate Import E2E' },
    { onConflict: 'id', ignoreDuplicates: true }
  )

  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .insert({ builder_id: BUILDER_ID, address: `${randomUUID()} Test St, Supplier Rate Import E2E`, status: 'active' })
    .select('id')
    .single()
  if (jobErr || !job) {
    log('setup_failed', { stage: 'create_job', error: jobErr?.message })
    process.exit(1)
  }
  jobId = job.id

  const { data: quote, error: quoteErr } = await supabase
    .from('quotes')
    .insert({ job_id: jobId, builder_id: BUILDER_ID, status: 'draft', total_cost: 0, margin_pct: 0.2, confidence_score: 100, version: 1, is_current: true })
    .select('id')
    .single()
  if (quoteErr || !quote) {
    log('setup_failed', { stage: 'create_quote', error: quoteErr?.message })
    await cleanup()
    process.exit(1)
  }
  quoteId = quote.id
  log('setup_complete', { job_id: jobId, quote_id: quoteId })

  async function addUnpricedLineItem(description) {
    const { data: item, error } = await supabase
      .from('quote_line_items')
      .insert({
        quote_id: quoteId, trade_category_id: 1,
        description, quantity: 10, unit: 'm2', rate: null, total: null,
        confidence: 100, is_assumption: false,
      })
      .select('id')
      .single()
    if (error || !item) throw new Error(`line item insert failed: ${error?.message}`)
    lineItemIds.push(item.id)
    return item.id
  }

  // ── 1. Import: one matched row, one deliberately unmatched row ─────────
  const item1Id = await addUnpricedLineItem(MATCHED_DESCRIPTION)

  const importRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/rates/import`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      builder_id: BUILDER_ID,
      supplier_name: SUPPLIER_NAME,
      rates: [
        { trade_category_id: 1, trade_category_name: 'Site Works & Concrete', description: MATCHED_DESCRIPTION, unit: 'm2', rate: 200 },
        { trade_category_id: 1, trade_category_name: 'Site Works & Concrete', description: UNMATCHED_DESCRIPTION, unit: 'm2', rate: 999 },
      ],
    }),
  })
  const importBody = await importRes.json().catch(() => ({}))
  log('import_call', { http_status: importRes.status, body: importBody })

  if (!importRes.ok || importBody.imported !== 1) {
    passed = false
    failures.push(`expected imported:1, got ${JSON.stringify(importBody)}`)
  }
  if (!Array.isArray(importBody.unmatched) || importBody.unmatched.length !== 1 || importBody.unmatched[0]?.description !== UNMATCHED_DESCRIPTION) {
    passed = false
    failures.push(`expected exactly 1 unmatched row reporting the unmatched description, got ${JSON.stringify(importBody.unmatched)}`)
  }

  // ── 2. Independent DB verification of the import ───────────────────────
  const { data: supplierRows } = await supabase
    .from('builder_supplier_rates')
    .select('id, line_item_key, rate, unit')
    .eq('builder_id', BUILDER_ID)
    .eq('supplier_name', SUPPLIER_NAME)
  log('supplier_rows_after_import', { rows: supplierRows })

  if ((supplierRows?.length ?? 0) !== 1) {
    passed = false
    failures.push(`expected exactly 1 builder_supplier_rates row, found ${supplierRows?.length ?? 0}`)
  }
  const supplierRow = supplierRows?.[0]
  if (supplierRow?.line_item_key !== 'site_slab') {
    passed = false
    failures.push(`expected line_item_key='site_slab' (the real catalogue key), got '${supplierRow?.line_item_key}'`)
  }
  if (Number(supplierRow?.rate) !== 200) {
    passed = false
    failures.push(`expected rate=200, got ${supplierRow?.rate}`)
  }

  // Confirm the unmatched description was never persisted under any key.
  const { data: unmatchedCheck } = await supabase
    .from('builder_supplier_rates')
    .select('id')
    .eq('builder_id', BUILDER_ID)
    .eq('supplier_name', SUPPLIER_NAME)
    .ilike('line_item_key', '%gate_hinges%')
  if ((unmatchedCheck?.length ?? 0) !== 0) {
    passed = false
    failures.push(`unmatched description was persisted anyway: ${JSON.stringify(unmatchedCheck)}`)
  }

  // ── 3. Real pricing path: GET the quote to trigger ensureQuotePriced ───
  const priceRes1 = await fetch(`${APP_URL.replace(/\/$/, '')}/api/quotes/${quoteId}`, { headers: authHeaders })
  const priceBody1 = await priceRes1.json().catch(() => ({}))
  log('price_call_1', { http_status: priceRes1.status })

  if (!priceRes1.ok) {
    passed = false
    failures.push(`expected 2xx from quote GET, got ${priceRes1.status}: ${JSON.stringify(priceBody1)}`)
  }

  const { data: pricedItem1 } = await supabase
    .from('quote_line_items')
    .select('rate, total, pricing_source')
    .eq('id', item1Id)
    .single()
  log('priced_item_1_state', pricedItem1 ?? {})

  if (pricedItem1?.pricing_source !== 'supplier') {
    passed = false
    failures.push(`expected pricing_source='supplier', got '${pricedItem1?.pricing_source}'`)
  }
  if (Number(pricedItem1?.rate) !== 200 || Number(pricedItem1?.total) !== 2000) {
    passed = false
    failures.push(`expected rate=200/total=2000 (10 x imported supplier rate), got rate=${pricedItem1?.rate} total=${pricedItem1?.total}`)
  }

  // ── 4. Re-import same supplier with a CHANGED price ─────────────────────
  const reimportRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/rates/import`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      builder_id: BUILDER_ID,
      supplier_name: SUPPLIER_NAME,
      rates: [
        { trade_category_id: 1, trade_category_name: 'Site Works & Concrete', description: MATCHED_DESCRIPTION, unit: 'm2', rate: 250 },
      ],
    }),
  })
  const reimportBody = await reimportRes.json().catch(() => ({}))
  log('reimport_call', { http_status: reimportRes.status, body: reimportBody })

  if (!reimportRes.ok || reimportBody.imported !== 1) {
    passed = false
    failures.push(`expected imported:1 on re-import, got ${JSON.stringify(reimportBody)}`)
  }

  const { data: supplierRowsAfterReimport } = await supabase
    .from('builder_supplier_rates')
    .select('id, line_item_key, rate')
    .eq('builder_id', BUILDER_ID)
    .eq('supplier_name', SUPPLIER_NAME)
  log('supplier_rows_after_reimport', { rows: supplierRowsAfterReimport })

  if ((supplierRowsAfterReimport?.length ?? 0) !== 1) {
    passed = false
    failures.push(`re-import created a duplicate row -- expected exactly 1, found ${supplierRowsAfterReimport?.length ?? 0}`)
  }
  if (supplierRowsAfterReimport?.[0]?.id !== supplierRow?.id) {
    passed = false
    failures.push(`re-import created a NEW row instead of updating the existing one (id changed: ${supplierRow?.id} -> ${supplierRowsAfterReimport?.[0]?.id})`)
  }
  if (Number(supplierRowsAfterReimport?.[0]?.rate) !== 250) {
    passed = false
    failures.push(`expected the existing row's rate to update to 250, got ${supplierRowsAfterReimport?.[0]?.rate}`)
  }

  // A second, freshly-added unpriced line item must price at the UPDATED rate.
  // Distinct description (still fuzzy-matches the same 'site_slab' catalogue
  // entry -- shares all its tokens) to avoid the quote_line_items unique
  // index on (quote_id, trade_category_id, description) (migration 030).
  const item2Id = await addUnpricedLineItem('Concrete slab on ground - second pour area')
  const priceRes2 = await fetch(`${APP_URL.replace(/\/$/, '')}/api/quotes/${quoteId}`, { headers: authHeaders })
  log('price_call_2', { http_status: priceRes2.status })

  const { data: pricedItem2 } = await supabase
    .from('quote_line_items')
    .select('rate, total, pricing_source')
    .eq('id', item2Id)
    .single()
  log('priced_item_2_state', pricedItem2 ?? {})

  if (pricedItem2?.pricing_source !== 'supplier' || Number(pricedItem2?.rate) !== 250 || Number(pricedItem2?.total) !== 2500) {
    passed = false
    failures.push(`expected the new item to price at the UPDATED supplier rate (250/2500), got ${JSON.stringify(pricedItem2)}`)
  }

  // First item must remain unchanged by the re-import (pricing is a one-shot
  // fill of previously-null totals, not a re-price of already-priced items).
  const { data: pricedItem1After } = await supabase
    .from('quote_line_items')
    .select('rate, total')
    .eq('id', item1Id)
    .single()
  if (Number(pricedItem1After?.rate) !== 200 || Number(pricedItem1After?.total) !== 2000) {
    passed = false
    failures.push(`expected the first (already-priced) item to remain at 200/2000, got ${JSON.stringify(pricedItem1After)}`)
  }

  log(passed ? 'run_passed' : 'run_FAILED', { passed, failures })
  await cleanup()
  process.exit(passed ? 0 : 1)
}

main().catch(async (err) => {
  log('run_crashed', { error: err instanceof Error ? err.stack : String(err) })
  await cleanup()
  process.exit(1)
})
