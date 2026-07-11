import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

export interface WorkerListItem {
  id: string
  name: string
  role: string
  status: 'invited' | 'active' | 'inactive'
  email: string | null
  phone: string | null
}

const DEMO_WORKERS: WorkerListItem[] = [
  { id: 'w-jack-001', name: 'Jack Thompson', role: 'Carpenter', status: 'invited', email: null, phone: null },
  { id: 'w-mick-002', name: 'Mick Reynolds', role: 'Plumber', status: 'invited', email: null, phone: null },
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
        .select('id, name, role, status, email, phone')
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
