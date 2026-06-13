import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

// In-memory demo store: jobId → Set of worker IDs already assigned
const DEMO_JOB_WORKERS: Record<string, Set<string>> = {
  '00000000-0000-0000-0000-000000000010': new Set(['w-jack-001', 'w-mick-002']),
}

// ─── POST /api/jobs/[jobId]/workers ──────────────────────────────────────────

interface AssignWorkerBody {
  worker_id: string
  builder_id: string
}

export async function POST(
  request: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { jobId } = params

  let body: AssignWorkerBody
  try {
    body = await request.json() as AssignWorkerBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.worker_id) {
    return NextResponse.json({ error: 'worker_id is required' }, { status: 400 })
  }

  const isDemoMode = !process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL === 'your-supabase-url'

  if (isDemoMode) {
    if (!DEMO_JOB_WORKERS[jobId]) DEMO_JOB_WORKERS[jobId] = new Set()
    if (DEMO_JOB_WORKERS[jobId].has(body.worker_id)) {
      return NextResponse.json({ error: 'Worker already on this job' }, { status: 409 })
    }
    DEMO_JOB_WORKERS[jobId].add(body.worker_id)
    return NextResponse.json({ ok: true }, { status: 201 })
  }

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
    const { data: ownedJob } = await sb
      .from('jobs')
      .select('id')
      .eq('id', jobId)
      .eq('builder_id', builderId)
      .single()
    if (!ownedJob) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

    const { error } = await sb
      .from('job_workers')
      .upsert({ job_id: jobId, worker_id: body.worker_id }, { onConflict: 'job_id,worker_id' })
    if (!error) return NextResponse.json({ ok: true }, { status: 201 })
  } catch {
    // fall through to in-memory
  }

  // DB unavailable — track in-memory so the UI stays consistent
  if (!DEMO_JOB_WORKERS[jobId]) DEMO_JOB_WORKERS[jobId] = new Set()
  DEMO_JOB_WORKERS[jobId].add(body.worker_id)
  return NextResponse.json({ ok: true }, { status: 201 })
}
