import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

// ─── Types ────────────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
}

// ─── Token exchange ───────────────────────────────────────────────────────────

async function exchangeGmailCode(
  code: string,
  redirectUri: string
): Promise<TokenResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  })

  if (!response.ok) {
    throw new Error(`Gmail token exchange failed: ${response.status}`)
  }

  return response.json() as Promise<TokenResponse>
}

async function exchangeOutlookCode(
  code: string,
  redirectUri: string
): Promise<TokenResponse> {
  const clientId = process.env.MICROSOFT_CLIENT_ID ?? ''
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET ?? ''

  const response = await fetch(
    'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: 'Mail.Read offline_access',
      }).toString(),
    }
  )

  if (!response.ok) {
    throw new Error(`Outlook token exchange failed: ${response.status}`)
  }

  return response.json() as Promise<TokenResponse>
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

  // The connection is bound to the builder whose session handles the
  // callback — never to an identity carried in the (forgeable) state param.
  const builder_id = await getAuthenticatedBuilderId()
  if (!builder_id) {
    return NextResponse.redirect(`${appUrl}/login?next=/settings/email`)
  }

  // State carries only the provider (legacy "builder:provider" still parses)
  const provider = (state?.includes(':') ? state.slice(state.indexOf(':') + 1) : state) as
    | 'gmail'
    | 'outlook'
    | null

  if (!provider || !['gmail', 'outlook'].includes(provider)) {
    return NextResponse.redirect(`${appUrl}/settings/email?error=invalid_provider`)
  }

  // Demo mode — no OAuth credentials configured
  const hasGmail = !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET
  const hasOutlook =
    !!process.env.MICROSOFT_CLIENT_ID && !!process.env.MICROSOFT_CLIENT_SECRET
  const hasCredentials = provider === 'gmail' ? hasGmail : hasOutlook

  if (!hasCredentials || !code) {
    return NextResponse.redirect(`${appUrl}/settings/email?connected=demo`)
  }

  try {
    const redirectUri = `${appUrl}/api/email-sync/callback`

    // Exchange code for tokens
    const tokens =
      provider === 'gmail'
        ? await exchangeGmailCode(code, redirectUri)
        : await exchangeOutlookCode(code, redirectUri)

    // Store sync state in Supabase if available
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (supabaseUrl && serviceRoleKey) {
      const supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })

      // Upsert email_sync_state
      await supabase.from('email_sync_state').upsert(
        {
          builder_id,
          provider,
          is_active: true,
          connected_at: new Date().toISOString(),
          last_synced_at: null,
          sync_cursor: null,
        },
        { onConflict: 'builder_id' }
      )

      // Update builders table
      await supabase
        .from('builders')
        .update({
          email_provider: provider,
          email_connected_at: new Date().toISOString(),
          email_sync_enabled: true,
        })
        .eq('id', builder_id)

      // In production, tokens would be encrypted before storage.
      // For now we acknowledge receipt without persisting raw secrets to the DB.
      void tokens
    }

    return NextResponse.redirect(`${appUrl}/settings/email?connected=true`)
  } catch (err) {
    console.error('[/api/email-sync/callback] Error:', err)
    return NextResponse.redirect(`${appUrl}/settings/email?error=token_exchange_failed`)
  }
}
