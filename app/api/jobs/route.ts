import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
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

// ─── POST /api/jobs ───────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { address?: string; builder_id?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const address = body.address?.trim()
  if (!address) {
    return NextResponse.json({ error: 'address is required' }, { status: 400 })
  }

  const builderId = body.builder_id ?? '00000000-0000-0000-0000-000000000001'

  const isDemoMode = !process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL === 'your-supabase-url'

  if (isDemoMode) {
    return NextResponse.json({
      job: { id: randomUUID(), address, status: 'quoting', builder_id: builderId },
    })
  }

  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  try {
    // Duplicate check — first 3 tokens of address
    const firstTokens = address.split(/\s+/).slice(0, 3).join(' ')
    const { data: existing } = await sb
      .from('jobs')
      .select('id, address, status')
      .eq('builder_id', builderId)
      .neq('status', 'archived')
      .ilike('address', `%${firstTokens}%`)
      .limit(1)
      .maybeSingle()

    if (existing) {
      return NextResponse.json({ job: existing, duplicate: true })
    }

    const { data: newJob, error } = await sb
      .from('jobs')
      .insert({
        id: randomUUID(),
        builder_id: builderId,
        address,
        status: 'quoting',
        client_id: null,
        job_type: null,
        notes: null,
        budget_estimate: null,
        scope_notes: null,
        quote_deadline: null,
        client_deadline: null,
      })
      .select('id, address, status')
      .single()

    if (error || !newJob) {
      throw new Error(error?.message ?? 'Insert failed')
    }

    return NextResponse.json({ job: newJob })
  } catch {
    // Demo fallback
    return NextResponse.json({
      job: { id: randomUUID(), address, status: 'quoting', builder_id: builderId },
    })
  }
}
