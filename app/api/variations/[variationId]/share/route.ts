import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

// ─── POST /api/variations/[variationId]/share ─────────────────────────────────
// Returns a client-facing approval link for the variation.
// In demo mode: returns a deterministic demo URL.
// In live mode: would create a signed token + store in DB.

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

  // In live mode you would create a signed token (e.g. JWT or UUID stored in DB)
  // and return `${appUrl}/approve/variation/${token}`.
  // For now we return a deterministic demo link that demonstrates the UX.
  const link = `${appUrl}/approve/variation/${variationId}`

  return NextResponse.json({ link })
}
