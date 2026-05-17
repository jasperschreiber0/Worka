import { NextRequest, NextResponse } from 'next/server'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConnectResponse {
  auth_url: string
}

interface DemoModeResponse {
  demo_mode: true
  message: string
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest
): Promise<NextResponse<ConnectResponse | DemoModeResponse>> {
  const { searchParams } = new URL(request.url)
  const provider = searchParams.get('provider') as 'gmail' | 'outlook' | null
  const builder_id = searchParams.get('builder_id')

  if (!provider || !['gmail', 'outlook'].includes(provider)) {
    return NextResponse.json(
      { demo_mode: true, message: "Invalid provider. Use 'gmail' or 'outlook'." },
      { status: 400 }
    )
  }

  if (!builder_id) {
    return NextResponse.json(
      { demo_mode: true, message: 'builder_id is required.' },
      { status: 400 }
    )
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const redirectUri = `${appUrl}/api/email-sync/callback`
  const state = `${builder_id}:${provider}`

  if (provider === 'gmail') {
    const googleClientId = process.env.GOOGLE_CLIENT_ID
    if (!googleClientId) {
      return NextResponse.json({
        demo_mode: true,
        message:
          'Email sync requires OAuth credentials. See .env.local.example for setup.',
      })
    }

    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state,
    })

    const auth_url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
    return NextResponse.json({ auth_url })
  }

  // Outlook
  const microsoftClientId = process.env.MICROSOFT_CLIENT_ID
  if (!microsoftClientId) {
    return NextResponse.json({
      demo_mode: true,
      message:
        'Email sync requires OAuth credentials. See .env.local.example for setup.',
    })
  }

  const params = new URLSearchParams({
    client_id: microsoftClientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'Mail.Read offline_access',
    state,
  })

  const auth_url = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`
  return NextResponse.json({ auth_url })
}
