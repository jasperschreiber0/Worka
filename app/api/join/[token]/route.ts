import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isDemoMode } from '@/lib/auth/api-auth'
import { generateWorkerSessionToken, WORKER_SESSION_COOKIE, WORKER_SESSION_TTL_MS } from '@/lib/auth/worker-session'
import { getDemoInvite } from '@/lib/worker-demo'

// ─── POST /api/join/[token] ───────────────────────────────────────────────────
// Completes worker onboarding: confirms the invite is real, saves the
// worker's confirmed name/phone, flips status invited -> active, and issues
// a worker-portal session cookie so /worker can identify them afterwards.

interface JoinRequestBody {
  name?: string
  phone?: string
}

interface JoinResponse {
  worker: { id: string; name: string; role: string }
  builder: { name: string; company: string }
  job: { address: string; ref: string } | null
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
): Promise<NextResponse<JoinResponse | { error: string }>> {
  const { token } = await params

  let body: JoinRequestBody = {}
  try {
    body = await request.json()
  } catch {
    // no body is fine — name/phone are both optional here
  }

  if (isDemoMode()) {
    const invite = getDemoInvite(token)
    if (!invite) {
      return NextResponse.json({ error: 'Invalid invite link' }, { status: 404 })
    }

    const res = NextResponse.json({
      worker: { id: invite.worker_id, name: body.name?.trim() || invite.worker_name, role: invite.role },
      builder: { name: invite.builder_name, company: invite.builder_company },
      job: invite.job_address ? { address: invite.job_address, ref: invite.job_ref } : null,
    } satisfies JoinResponse)

    // Demo mode: the cookie just names which seeded worker this is — there's
    // no real session secret to protect since the data behind it is fake.
    res.cookies.set(WORKER_SESSION_COOKIE, `demo:${invite.worker_id}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: WORKER_SESSION_TTL_MS / 1000,
      path: '/',
    })
    return res
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

  const { data: workerRow, error: workerErr } = await supabase
    .from('workers')
    .select('id, builder_id, name, role, status')
    .eq('invite_token', token)
    .single()

  if (workerErr || !workerRow) {
    return NextResponse.json({ error: 'Invalid invite link' }, { status: 404 })
  }

  const confirmedName = body.name?.trim() || workerRow.name
  const session = generateWorkerSessionToken()

  const { error: updateErr } = await supabase
    .from('workers')
    .update({
      name: confirmedName,
      phone: body.phone?.trim() || undefined,
      status: workerRow.status === 'invited' ? 'active' : workerRow.status,
      session_token_hash: session.tokenHash,
      session_token_expires_at: session.expiresAt,
    })
    .eq('id', workerRow.id)

  if (updateErr) {
    console.error('[join] worker update failed:', updateErr.message)
    return NextResponse.json({ error: 'Failed to complete onboarding' }, { status: 500 })
  }

  const [{ data: builderRow }, { data: jobWorkerRow }] = await Promise.all([
    supabase.from('builders').select('name, business_name').eq('id', workerRow.builder_id).single(),
    supabase
      .from('job_workers')
      .select('jobs ( address, job_ref )')
      .eq('worker_id', workerRow.id)
      .order('assigned_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const firstJob = (jobWorkerRow as { jobs: { address: string; job_ref: string | null } | null } | null)?.jobs ?? null

  const res = NextResponse.json({
    worker: { id: workerRow.id, name: confirmedName, role: workerRow.role },
    builder: { name: builderRow?.name ?? 'Your builder', company: builderRow?.business_name ?? '' },
    job: firstJob ? { address: firstJob.address, ref: firstJob.job_ref ?? '' } : null,
  } satisfies JoinResponse)

  res.cookies.set(WORKER_SESSION_COOKIE, session.rawToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: WORKER_SESSION_TTL_MS / 1000,
    path: '/',
  })

  return res
}
