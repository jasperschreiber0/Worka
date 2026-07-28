import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { createWorker } from '@/lib/workers'

export interface WorkerListItem {
  id: string
  name: string
  role: string
  status: 'invited' | 'active' | 'inactive'
  email: string | null
  phone: string | null
  hourly_rate?: number | null
  default_markup_pct?: number | null
  available?: boolean
}

const DEMO_WORKERS: WorkerListItem[] = [
  { id: 'w-jack-001', name: 'Jack Thompson', role: 'Carpenter', status: 'invited', email: null, phone: null, available: true },
  { id: 'w-mick-002', name: 'Mick Reynolds', role: 'Plumber', status: 'invited', email: null, phone: null, available: true },
]

export async function GET(request: NextRequest) {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (sbUrl && sbKey) {
    // A real query failure must surface as a real error — falling back to
    // DEMO_WORKERS would show a real builder fictional crew members with
    // nothing indicating they aren't real.
    try {
      const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
      const { data, error } = await sb
        .from('workers')
        .select('id, name, role, status, email, phone, hourly_rate, default_markup_pct, available')
        .eq('builder_id', builderId)
        .neq('status', 'inactive')
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) {
        console.error('[/api/workers] query failed:', error.message)
        return NextResponse.json({ error: 'Failed to load workers' }, { status: 500 })
      }
      return NextResponse.json({ workers: data ?? [] })
    } catch (err) {
      console.error('[/api/workers] error:', err)
      return NextResponse.json({ error: 'Failed to load workers' }, { status: 500 })
    }
  }

  return NextResponse.json({ workers: DEMO_WORKERS })
}

// ─── POST /api/workers ────────────────────────────────────────────────────────
// The Team panel's direct create path — calls the same createWorker() the
// chat `add_worker` intent already uses (lib/workers.ts), so a worker added
// via this form and one added by typing "add worker Jack, carpenter" are
// indistinguishable afterward (same invite-token generation, same demo-mode
// fallback). builder_id is always derived from the session, never trusted
// from the request body.
export async function POST(request: NextRequest) {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: {
    name?: string
    role?: string
    email?: string
    phone?: string
    hourly_rate?: number
    default_markup_pct?: number
    available?: boolean
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const name = body.name?.trim()
  const role = body.role?.trim()
  if (!name || !role) {
    return NextResponse.json({ error: 'Name and trade are required' }, { status: 400 })
  }

  try {
    const result = await createWorker({
      builder_id: builderId,
      name,
      role,
      email: body.email,
      phone: body.phone,
      hourly_rate: body.hourly_rate,
      default_markup_pct: body.default_markup_pct,
      available: body.available,
    })
    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    console.error('[/api/workers] create failed:', err)
    return NextResponse.json({ error: 'Failed to add worker' }, { status: 500 })
  }
}
