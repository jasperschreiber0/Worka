import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { demoImportedRates, type ImportedRate } from '@/lib/rates-import-demo'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { loadPricingCatalogue } from '@/lib/pricing'
import { planSupplierRateImport } from '@/lib/rates-import'

interface RateRow {
  trade_category_id: number
  trade_category_name: string
  description: string
  unit: string
  rate: number
}

interface ImportBody {
  builder_id: string
  supplier_name: string
  rates: RateRow[]
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: ImportBody
  try {
    body = (await request.json()) as ImportBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const builder_id = await getAuthenticatedBuilderId()
  if (!builder_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { supplier_name, rates } = body
  if (!rates?.length) {
    return NextResponse.json({ error: 'rates are required' }, { status: 400 })
  }

  const now = new Date().toISOString()

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (sbUrl && sbKey) {
    try {
      const { createClient } = await import('@supabase/supabase-js')
      const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })

      // FIX (Round 10 reliability audit, persistence truthfulness): resolve
      // each row against the SAME catalogue pricing itself uses
      // (loadPricingCatalogue -> matchLineItemKey, lib/pricing.ts) before
      // persisting anything — see lib/rates-import.ts's own header comment
      // for why a description-derived key was permanently unreachable by
      // Tier 3. Only rows that genuinely match a catalogue entry are
      // stored; everything else is reported back, never silently imported
      // under a key nothing will ever look up.
      const catalogue = await loadPricingCatalogue(sb)
      const supplierName = supplier_name || 'Imported'
      const { matched, unmatched } = planSupplierRateImport(rates, catalogue, builder_id, supplierName, now)

      if (matched.length > 0) {
        // Upsert, not insert: a re-import of an updated price list from the
        // SAME supplier must update the existing rate under
        // (builder_id, supplier_name, line_item_key) — migration 001's own
        // unique constraint — not 500 the entire batch on a duplicate-key
        // violation (the old insert's behaviour). Both supplier_name and
        // builder_id are part of that same key, so a different supplier or
        // a different builder always lands on its own row; this can never
        // merge or overwrite another supplier's or another builder's rates.
        // `id` is deliberately omitted from the payload: the column's own
        // DEFAULT fills it on a genuine insert, and since `id` isn't part
        // of the conflict target it's left untouched on an update — no
        // reason to churn a row's identity just because its price changed.
        const { error } = await sb
          .from('builder_supplier_rates')
          .upsert(matched, { onConflict: 'builder_id,supplier_name,line_item_key' })
        if (error) {
          console.error('[rates/import] upsert failed:', error.message)
          return NextResponse.json({ error: 'Failed to import rates' }, { status: 500 })
        }
      }

      return NextResponse.json({ imported: matched.length, unmatched })
    } catch (err) {
      // Real mode was configured, so this is a genuine failure — falling
      // back to the in-memory demo store would tell the builder their rates
      // were imported into their real account when nothing was persisted
      // (and the in-memory copy doesn't even survive a cold start).
      console.error('[rates/import] error:', err)
      return NextResponse.json({ error: 'Failed to import rates' }, { status: 500 })
    }
  }

  // Demo / DB-unavailable path — store in-memory
  const imported: ImportedRate[] = rates.map((r) => ({
    id: randomUUID(),
    trade_category_id: r.trade_category_id,
    trade_category_name: r.trade_category_name,
    description: r.description,
    unit: r.unit,
    rate: r.rate,
    supplier_name: supplier_name || 'Imported',
    imported_at: now,
  }))

  demoImportedRates.push(...imported)

  return NextResponse.json({ imported: imported.length })
}
