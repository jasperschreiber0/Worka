import { NextRequest, NextResponse } from 'next/server'
import { getDemoJobList } from '@/lib/job-snapshot-demo'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'

// ─── GET /api/jobs ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isDemoMode()) {
    return NextResponse.json({ jobs: getDemoJobList() })
  }


  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  // A real query failure here must surface as a real error — falling back
  // to demo jobs would show a real, authenticated builder fictional jobs
  // (Fitzroy/Toorak/Brunswick) with nothing indicating they aren't real.
  try {
    const { data, error } = await sb
      .from('jobs')
      .select('id, address, status')
      .eq('builder_id', builderId)
      .not('status', 'eq', 'archived')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[/api/jobs] query failed:', error.message)
      return NextResponse.json({ error: 'Failed to load jobs' }, { status: 500 })
    }
    return NextResponse.json({ jobs: data ?? [] })
  } catch (err) {
    console.error('[/api/jobs] error:', err)
    return NextResponse.json({ error: 'Failed to load jobs' }, { status: 500 })
  }
}
