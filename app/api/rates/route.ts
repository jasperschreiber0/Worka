import { NextRequest, NextResponse } from 'next/server'
import { demoImportedRates } from '@/lib/rates-import-demo'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (sbUrl && sbKey) {
    try {
      const { createClient } = await import('@supabase/supabase-js')
      const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
      const { data, error } = await sb
        .from('builder_supplier_rates')
        .select('id, supplier_name, line_item_key, rate, unit, imported_at')
        .eq('builder_id', builderId)
        .order('imported_at', { ascending: false })
        .limit(200)
      if (!error) return NextResponse.json({ rates: data ?? [] })
    } catch {
      // fall through
    }
  }

  return NextResponse.json({ rates: demoImportedRates })
}
