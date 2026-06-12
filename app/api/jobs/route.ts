import { NextRequest, NextResponse } from 'next/server'
import { getDemoJobList } from '@/lib/job-snapshot-demo'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

// ─── GET /api/jobs ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const isDemoMode = !process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL === 'your-supabase-url'

  if (isDemoMode) {
    return NextResponse.json({ jobs: getDemoJobList() })
  }


  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  try {
    const { data, error } = await sb
      .from('jobs')
      .select('id, address, status')
      .eq('builder_id', builderId)
      .not('status', 'eq', 'archived')
      .order('created_at', { ascending: false })

    if (!error) return NextResponse.json({ jobs: data ?? [] })
  } catch {
    // fall through to demo
  }

  return NextResponse.json({ jobs: getDemoJobList() })
}
