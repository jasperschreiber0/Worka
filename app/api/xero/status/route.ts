// Authentication and connection state must be evaluated for every request.
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'

export async function GET() {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (process.env.XERO_ENABLED !== 'true') return NextResponse.json({ connections: [], disabled: true })
  if (isDemoMode()) return NextResponse.json({ connections: [], demo: true })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ connections: [] })
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await sb.from('xero_connections').select('id, organisation_name, status, connected_at, last_synced_at').eq('builder_id', builderId).order('connected_at', { ascending: false })
  if (error) return NextResponse.json({ error: 'Could not load Xero connection status.' }, { status: 500 })
  return NextResponse.json({ connections: data ?? [] })
}
