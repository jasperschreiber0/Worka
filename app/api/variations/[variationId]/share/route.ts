import { NextRequest, NextResponse } from 'next/server'
import { randomBytes, createHash } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'

// ─── POST /api/variations/[variationId]/share ─────────────────────────────────
// Returns a client-facing approval link for the variation.
// Real mode: mints a random token, stores only its SHA-256 hash + an expiry
// against the variation row, and returns the link with the raw token in the
// query string — the public GET/PATCH endpoints verify it before acting.
// Demo mode: no real client data exists, so we keep the deterministic demo
// link with no token, matching the rest of the demo-mode UX.

const SHARE_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export async function POST(
  _req: NextRequest,
  { params }: { params: { variationId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { variationId } = params
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://getworka.com'

  if (isDemoMode()) {
    return NextResponse.json({ link: `${appUrl}/approve/variation/${variationId}` })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

  const { data: variation } = await supabase
    .from('variations')
    .select('id')
    .eq('id', variationId)
    .eq('builder_id', builderId)
    .single()

  if (!variation) {
    return NextResponse.json({ error: 'Variation not found' }, { status: 404 })
  }

  const rawToken = randomBytes(24).toString('base64url')
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  const expiresAt = new Date(Date.now() + SHARE_LINK_TTL_MS).toISOString()

  const { error } = await supabase
    .from('variations')
    .update({ share_token_hash: tokenHash, share_token_expires_at: expiresAt })
    .eq('id', variationId)

  if (error) {
    console.error('[variations/share]', error)
    return NextResponse.json({ error: 'Failed to generate share link' }, { status: 500 })
  }

  const link = `${appUrl}/approve/variation/${variationId}?t=${rawToken}`
  return NextResponse.json({ link })
}
