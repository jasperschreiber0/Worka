import { NextRequest, NextResponse } from 'next/server'
import { getDemoJobList } from '@/lib/job-snapshot-demo'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { createJob } from '@/lib/jobs'

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

// ─── POST /api/jobs ───────────────────────────────────────────────────────────
// The New Job panel's direct create path — calls the same createJob() the
// chat `new_job` intent already uses (lib/jobs.ts), including its duplicate-
// address detection. builder_id always derives from the session.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { address?: string; client_name?: string; budget_hint?: string; scope_notes?: string; force_create?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const address = body.address?.trim()
  if (!address) {
    return NextResponse.json({ error: 'Address is required' }, { status: 400 })
  }

  try {
    const result = await createJob({
      builder_id: builderId,
      address,
      client_name: body.client_name,
      budget_hint: body.budget_hint,
      scope_notes: body.scope_notes,
      force_create: body.force_create,
    })
    return NextResponse.json(result, { status: result.is_duplicate ? 200 : 201 })
  } catch (err) {
    console.error('[/api/jobs] create failed:', err)
    return NextResponse.json({ error: 'Failed to create job' }, { status: 500 })
  }
}
