import { NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { listNotifications } from '@/lib/notifications'

// ─── GET /api/notifications ───────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { notifications, unread_count } = await listNotifications(builderId)
  return NextResponse.json({ notifications, unread_count })
}
