import { NextRequest, NextResponse } from 'next/server'
import { getDemoJobList } from '@/lib/job-snapshot-demo'

// ─── GET /api/jobs ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const builderId = request.nextUrl.searchParams.get('builder_id')

  const isDemoMode = !process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL === 'your-supabase-url'

  if (isDemoMode) {
    return NextResponse.json({ jobs: getDemoJobList() })
  }

  if (!builderId) {
    return NextResponse.json({ error: 'builder_id is required' }, { status: 400 })
  }

  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data, error } = await sb
    .from('jobs')
    .select('id, address, status')
    .eq('builder_id', builderId)
    .not('status', 'eq', 'archived')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ jobs: data ?? [] })
}
