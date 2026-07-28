import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { markNotificationsRead } from '@/lib/notifications'

interface MarkReadBody {
  ids?: string[]
  all?: boolean
}

// ─── POST /api/notifications/mark-read ────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: MarkReadBody
  try {
    body = await request.json() as MarkReadBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.all && (!body.ids || body.ids.length === 0)) {
    return NextResponse.json({ error: 'ids or all is required' }, { status: 400 })
  }

  await markNotificationsRead(builderId, body.all ? 'all' : body.ids!)
  return NextResponse.json({ ok: true })
}
