import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/xero-crypto'

export async function getXeroAccessToken(builderId: string) {
  if (process.env.XERO_ENABLED !== 'true') return null
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || !process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET || !process.env.XERO_TOKEN_ENCRYPTION_KEY) return null
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: connection } = await sb.from('xero_connections').select('*').eq('builder_id', builderId).eq('status', 'active').limit(1).maybeSingle()
  if (!connection?.access_token_encrypted) return null
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0
  if (expiresAt > Date.now() + 120000) return { accessToken: decrypt(connection.access_token_encrypted), connection, sb }
  if (!connection.refresh_token_encrypted) return null
  const refreshResponse = await fetch('https://identity.xero.com/connect/token', { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decrypt(connection.refresh_token_encrypted) }).toString() })
  if (!refreshResponse.ok) { await sb.from('xero_connections').update({ status: 'needs_reauth' }).eq('id', connection.id); return null }
  const tokens = await refreshResponse.json() as { access_token: string; refresh_token: string; expires_in: number }
  await sb.from('xero_connections').update({ access_token_encrypted: (await import('@/lib/xero-crypto')).encrypt(tokens.access_token), refresh_token_encrypted: (await import('@/lib/xero-crypto')).encrypt(tokens.refresh_token), token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString() }).eq('id', connection.id)
  return { accessToken: tokens.access_token, connection, sb }
}
