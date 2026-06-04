import { NextRequest, NextResponse } from 'next/server'
import { demoImportedRates } from '@/lib/rates-import-demo'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const builderId = request.nextUrl.searchParams.get('builder_id')

  const isDemoMode = !process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL === 'your-supabase-url'

  if (isDemoMode) {
    return NextResponse.json({ rates: demoImportedRates })
  }

  if (!builderId) {
    return NextResponse.json({ error: 'builder_id is required' }, { status: 400 })
  }

  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  try {
    const { data, error } = await sb
      .from('builder_supplier_rates')
      .select('id, trade_category_id, description, unit, rate, supplier_name, created_at')
      .eq('builder_id', builderId)
      .order('created_at', { ascending: false })

    if (!error) {
      return NextResponse.json({ rates: data ?? [] })
    }
  } catch { /* fall through */ }

  return NextResponse.json({ rates: demoImportedRates })
}
