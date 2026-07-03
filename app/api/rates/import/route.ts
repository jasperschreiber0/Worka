import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { demoImportedRates, type ImportedRate } from '@/lib/rates-import-demo'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

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

      const rows = rates.map((r) => ({
        id: randomUUID(),
        builder_id,
        supplier_name: supplier_name || 'Imported',
        line_item_key: `${r.trade_category_id}_${r.description.toLowerCase().replace(/\s+/g, '_').slice(0, 60)}`,
        rate: r.rate,
        unit: r.unit,
        imported_at: now,
      }))

      const { error } = await sb.from('builder_supplier_rates').insert(rows)
      if (!error) {
        return NextResponse.json({ imported: rows.length })
      }
    } catch {
      // fall through to demo store
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
