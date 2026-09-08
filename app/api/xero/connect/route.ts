// Authentication and connection state must be evaluated for every request.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { createXeroOAuthState, hashXeroOAuthState, XERO_OAUTH_STATE_COOKIE, xeroStateCookieOptions } from '@/lib/xero-oauth-state'
import { createClient } from '@supabase/supabase-js'

export async function GET(request: NextRequest) {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (process.env.XERO_ENABLED !== 'true') return NextResponse.json({ setup_required: true, disabled: true, message: 'Xero is not enabled for this release.' })
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  if (isDemoMode() || !process.env.XERO_CLIENT_ID) {
    return NextResponse.json({ setup_required: true, message: 'Xero connection is ready for setup. Add XERO_CLIENT_ID and XERO_CLIENT_SECRET to enable live authorisation.' })
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || !process.env.XERO_CLIENT_SECRET || !process.env.XERO_TOKEN_ENCRYPTION_KEY) {
    return NextResponse.json({ error: 'Xero is not configured.' }, { status: 503 })
  }
  let state: string
  try {
    state = createXeroOAuthState(builderId)
    const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const cleanup = await sb.from('xero_oauth_transactions').delete().eq('builder_id', builderId).lte('expires_at', new Date().toISOString())
    if (cleanup.error) throw new Error('State cleanup failed')
    const { error } = await sb.from('xero_oauth_transactions').insert({ state_hash: hashXeroOAuthState(state), builder_id: builderId })
    if (error) throw new Error('State creation failed')
  } catch {
    return NextResponse.json({ error: 'Could not start Xero authorisation.' }, { status: 503 })
  }
  const params = new URLSearchParams({ client_id: process.env.XERO_CLIENT_ID, redirect_uri: `${appUrl}/api/xero/callback`, response_type: 'code', scope: 'openid profile email accounting.transactions accounting.contacts offline_access', state })
  const response = NextResponse.json({ auth_url: `https://login.xero.com/identity/connect/authorize?${params.toString()}` })
  response.headers.set('Cache-Control', 'no-store')
  response.cookies.set(XERO_OAUTH_STATE_COOKIE, state, xeroStateCookieOptions())
  return response
}
