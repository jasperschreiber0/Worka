import { NextRequest, NextResponse } from 'next/server'
import type { JobTask } from '@/lib/job-snapshot-demo'

// In-memory store for demo tasks (keyed by jobId)
const DEMO_TASKS: Record<string, JobTask[]> = {}

function getDemoTasks(jobId: string): JobTask[] {
  return DEMO_TASKS[jobId] ?? []
}

// ─── GET /api/jobs/[jobId]/tasks ─────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const { jobId } = params

  const isDemoMode = !process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL === 'your-supabase-url'

  if (isDemoMode) {
    return NextResponse.json({ tasks: getDemoTasks(jobId) })
  }

  const sb = await getSupabaseClient()
  const { data, error } = await sb
    .from('job_tasks')
    .select('id, description, assigned_to, assigned_worker_id, status, created_at')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ tasks: data ?? [] })
}

// ─── POST /api/jobs/[jobId]/tasks ────────────────────────────────────────────

interface CreateTaskBody {
  description: string
  assigned_worker_id?: string | null
  assigned_to?: string | null
  builder_id: string
}

interface CompleteTaskBody {
  action: 'complete' | 'reopen'
  task_id: string
  builder_id: string
}

export async function POST(
  request: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const { jobId } = params

  let body: CreateTaskBody | CompleteTaskBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const isDemoMode = !process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL === 'your-supabase-url'

  // ── Complete / reopen action ──────────────────────────────────────────────
  if ('action' in body && (body.action === 'complete' || body.action === 'reopen')) {
    const newStatus = body.action === 'complete' ? 'done' : 'open'
    if (isDemoMode) {
      if (!DEMO_TASKS[jobId]) DEMO_TASKS[jobId] = []
      DEMO_TASKS[jobId] = DEMO_TASKS[jobId].map((t) =>
        t.id === body.task_id ? { ...t, status: newStatus } : t
      )
      return NextResponse.json({ ok: true })
    }

    const sb = await getSupabaseClient()
    const { error } = await sb
      .from('job_tasks')
      .update({ status: newStatus })
      .eq('id', body.task_id)
      .eq('job_id', jobId)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  // ── Create action ─────────────────────────────────────────────────────────
  const createBody = body as CreateTaskBody
  if (!createBody.description?.trim()) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 })
  }

  if (isDemoMode) {
    const newTask: JobTask = {
      id: `demo-task-${Date.now()}`,
      description: createBody.description.trim(),
      assigned_to: createBody.assigned_to ?? null,
      assigned_worker_id: createBody.assigned_worker_id ?? null,
      status: 'open',
      created_at: 'just now',
    }
    if (!DEMO_TASKS[jobId]) DEMO_TASKS[jobId] = []
    DEMO_TASKS[jobId].unshift(newTask)
    return NextResponse.json({ task: newTask }, { status: 201 })
  }

  const sb = await getSupabaseClient()
  const { data, error } = await sb
    .from('job_tasks')
    .insert({
      job_id: jobId,
      description: createBody.description.trim(),
      assigned_worker_id: createBody.assigned_worker_id ?? null,
      assigned_to: createBody.assigned_to ?? null,
      status: 'open',
    })
    .select('id, description, assigned_to, assigned_worker_id, status, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ task: data }, { status: 201 })
}

// ─── Supabase client helper ───────────────────────────────────────────────────

async function getSupabaseClient() {
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}
