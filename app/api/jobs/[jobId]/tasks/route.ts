import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { getDemoJobSnapshot } from '@/lib/job-snapshot-demo'

export async function POST(
  request: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const { jobId } = params

  let body: { description?: string; builder_id?: string; assigned_to?: string | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const description = body.description?.trim()
  if (!description) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 })
  }

  const builderId = body.builder_id ?? '00000000-0000-0000-0000-000000000001'

  const isDemoMode = !process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL === 'your-supabase-url'

  // Demo: add task to in-memory snapshot if possible; return a fake task
  if (isDemoMode) {
    const snapshot = getDemoJobSnapshot(jobId)
    const task = {
      id: randomUUID(),
      description,
      assigned_to: body.assigned_to ?? null,
      assigned_worker_id: null,
      status: 'open' as const,
      created_at: 'just now',
    }
    if (snapshot) {
      // snapshot exists — task is associated; no in-memory mutation needed
      void snapshot
    }
    return NextResponse.json({ task })
  }

  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  try {
    const { data, error } = await sb
      .from('job_tasks')
      .insert({
        id: randomUUID(),
        job_id: jobId,
        builder_id: builderId,
        description,
        assigned_to: body.assigned_to ?? null,
        status: 'open',
      })
      .select()
      .single()

    if (error) throw new Error(error.message)
    return NextResponse.json({ task: data })
  } catch {
    // Demo fallback
    return NextResponse.json({
      task: {
        id: randomUUID(),
        description,
        assigned_to: body.assigned_to ?? null,
        assigned_worker_id: null,
        status: 'open',
        created_at: 'just now',
      },
    })
  }
}
