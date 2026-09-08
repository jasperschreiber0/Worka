// Authentication and connection state must be evaluated for every request.
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'

export async function GET() {
  if (process.env.XERO_ENABLED !== 'true') return NextResponse.json({ runs: [], disabled: true })
  if (isDemoMode()) return NextResponse.json({ runs: [{ id: 'demo-sync-1', status: 'completed', started_at: new Date(Date.now() - 86400000).toISOString(), completed_at: new Date(Date.now() - 86300000).toISOString(), imported_count: 3, failed_count: 0 }] })
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ runs: [] })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ runs: [] })
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await supabase.from('xero_sync_runs').select('id,status,started_at,completed_at,imported_count,failed_count,error_message').eq('builder_id', builderId).order('started_at', { ascending: false }).limit(10)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ runs: data ?? [] })
}
