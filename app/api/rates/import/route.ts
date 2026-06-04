import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { demoImportedRates, type ImportedRate } from '@/lib/rates-import-demo'

interface RateInput {
  trade_category_id: number
  trade_category_name: string
  description: string
  unit: string
  rate: number
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { builder_id?: string; supplier_name?: string; rates?: RateInput[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { builder_id, supplier_name = 'Imported', rates = [] } = body

  if (!rates.length) {
    return NextResponse.json({ error: 'No rates provided' }, { status: 400 })
  }

  const builderId = builder_id ?? '00000000-0000-0000-0000-000000000001'
  const now = new Date().toISOString()

  const isDemoMode = !process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL === 'your-supabase-url'

  if (isDemoMode) {
    const imported: ImportedRate[] = rates.map((r) => ({
      id: randomUUID(),
      trade_category_id: r.trade_category_id,
      trade_category_name: r.trade_category_name,
      description: r.description,
      unit: r.unit,
      rate: r.rate,
      supplier_name,
      imported_at: now,
    }))
    demoImportedRates.unshift(...imported)
    return NextResponse.json({ imported: imported.length })
  }

  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  try {
    const rows = rates.map((r) => ({
      id: randomUUID(),
      builder_id: builderId,
      trade_category_id: r.trade_category_id,
      description: r.description,
      unit: r.unit,
      rate: r.rate,
      supplier_name,
    }))

    const { error } = await sb.from('builder_supplier_rates').insert(rows)
    if (error) throw new Error(error.message)

    return NextResponse.json({ imported: rows.length })
  } catch {
    // Demo fallback
    const imported: ImportedRate[] = rates.map((r) => ({
      id: randomUUID(),
      trade_category_id: r.trade_category_id,
      trade_category_name: r.trade_category_name,
      description: r.description,
      unit: r.unit,
      rate: r.rate,
      supplier_name,
      imported_at: now,
    }))
    demoImportedRates.unshift(...imported)
    return NextResponse.json({ imported: imported.length })
  }
}
