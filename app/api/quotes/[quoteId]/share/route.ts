import { NextRequest, NextResponse } from 'next/server'
import { randomBytes, createHash } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'

// ─── POST /api/quotes/[quoteId]/share ──────────────────────────────────────
// Returns a client-facing quote-approval link. Mirrors
// app/api/variations/[variationId]/share/route.ts exactly: mints a random
// token, stores only its SHA-256 hash + an expiry against the quote row,
// and returns the link with the raw token in the query string — the public
// GET/PATCH endpoints (app/api/quotes/[quoteId]/approve/route.ts) verify it
// before acting. No status restriction on minting (matching the variation
// share route) — the approve route's own status-filtered update is what
// actually gates whether the link can be used to approve.

const SHARE_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days — matches the existing "Quote valid for 30 days" copy in send/route.ts

export async function POST(
  _req: NextRequest,
  { params }: { params: { quoteId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { quoteId } = params
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://getworka.com'

  if (isDemoMode()) {
    return NextResponse.json({ link: `${appUrl}/approve/quote/${quoteId}` })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

  const { data: quote } = await supabase
    .from('quotes')
    .select('id')
    .eq('id', quoteId)
    .eq('builder_id', builderId)
    .single()

  if (!quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
  }

  const rawToken = randomBytes(24).toString('base64url')
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  const expiresAt = new Date(Date.now() + SHARE_LINK_TTL_MS).toISOString()

  const { error } = await supabase
    .from('quotes')
    .update({ share_token_hash: tokenHash, share_token_expires_at: expiresAt })
    .eq('id', quoteId)

  if (error) {
    console.error('[quotes/share]', error)
    return NextResponse.json({ error: 'Failed to generate share link' }, { status: 500 })
  }

  const link = `${appUrl}/approve/quote/${quoteId}?t=${rawToken}`
  return NextResponse.json({ link })
}
