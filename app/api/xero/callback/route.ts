// Authentication and connection state must be evaluated for every request.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { createClient } from '@supabase/supabase-js'
import { encrypt } from '@/lib/xero-crypto'
import { runXeroOAuthCallback, XERO_OAUTH_STATE_COOKIE, xeroStateCookieOptions } from '@/lib/xero-oauth-state'

export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const finish = (status: 'connected' | 'error') => {
    const response = NextResponse.redirect(`${appUrl}/settings/xero?status=${status}`)
    response.headers.set('Cache-Control', 'no-store')
    response.cookies.set(XERO_OAUTH_STATE_COOKIE, '', xeroStateCookieOptions(true))
    return response
  }
  try {
    if (process.env.XERO_ENABLED !== 'true') return finish('error')
    const builderId = await getAuthenticatedBuilderId()
    const params = new URL(request.url).searchParams
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!builderId || !url || !key || !process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET || !process.env.XERO_TOKEN_ENCRYPTION_KEY || params.has('error')) return finish('error')
    if (params.getAll('state').length !== 1 || params.getAll('code').length !== 1) return finish('error')
    const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const completed = await runXeroOAuthCallback({
      state: params.get('state'), cookie: request.cookies.get(XERO_OAUTH_STATE_COOKIE)?.value,
      builderId, code: params.get('code'),
    }, async (hash, owner) => {
      const { data, error } = await sb.rpc('consume_xero_oauth_state', { p_state_hash: hash, p_builder_id: owner })
      if (error) throw new Error('State consumption failed')
      return data === true
    }, async () => {
      const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
        method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: params.get('code')!, redirect_uri: `${appUrl}/api/xero/callback` }).toString(),
        cache: 'no-store',
      })
      if (!tokenResponse.ok) throw new Error('Token exchange failed')
      const tokens = await tokenResponse.json()
      if (typeof tokens.access_token !== 'string' || !tokens.access_token || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error('Invalid token response')
      const tenantsResponse = await fetch('https://api.xero.com/connections', { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' }, cache: 'no-store' })
      if (!tenantsResponse.ok) throw new Error('Organisation lookup failed')
      const tenants: Array<{ tenantId: string; tenantName?: string }> = await tenantsResponse.json()
      if (!Array.isArray(tenants) || !tenants.length || tenants.some(t => !t || typeof t.tenantId !== 'string' || !t.tenantId)) throw new Error('Invalid organisations')
      // One statement: all connections persist atomically or none do.
      const { error } = await sb.from('xero_connections').upsert(tenants.map(tenant => ({
        builder_id: builderId, tenant_id: tenant.tenantId, organisation_name: tenant.tenantName ?? null,
        status: 'active', access_token_encrypted: encrypt(tokens.access_token), refresh_token_encrypted: encrypt(tokens.refresh_token),
        token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      })), { onConflict: 'builder_id,tenant_id' })
      if (error) throw new Error('Connection persistence failed')
    })
    return finish(completed ? 'connected' : 'error')
  } catch {
    // Do not log provider bodies, state, codes, or tokens.
    return finish('error')
  }
}
