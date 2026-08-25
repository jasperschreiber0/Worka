import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { isValidTradeCategoryId } from '@/lib/trade-taxonomy'

// ─── GET/POST /api/jobs/[jobId]/costs ─────────────────────────────────────────
//
// Financials v1 — Live Job Money. A live, per-job, incremental actual-cost
// ledger — "the costs the builder has actually logged," not an accounting
// system. See migration 097 for why this needed a new table (cost_reconciliation
// is a different, unrelated, close-out-only mechanism).
//
// Ownership is checked explicitly against the jobs table on every request —
// the jobId route param alone proves nothing; a builder must also own that
// job row before any cost entry under it is readable or writable.

interface CreateBody {
  trade_category_id?: number | null
  description?: string
  amount?: number
  incurred_on?: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime())
}

async function jobOwnedByBuilder(
  supabase: SupabaseClient,
  jobId: string,
  builderId: string
): Promise<boolean> {
  const { data } = await supabase.from('jobs').select('id').eq('id', jobId).eq('builder_id', builderId).single()
  return !!data
}

// ─── GET ───────────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isDemoMode()) {
    return NextResponse.json({ costs: [] })
  }

  const { jobId } = params

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    if (!(await jobOwnedByBuilder(supabase, jobId, builderId))) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const { data, error } = await supabase
      .from('job_cost_entries')
      .select('id, trade_category_id, description, amount, incurred_on, created_at')
      .eq('job_id', jobId)
      .order('incurred_on', { ascending: false })
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ costs: data ?? [] })
  } catch (err) {
    console.error('[jobs/costs:get] error:', err)
    return NextResponse.json({ error: 'Failed to load costs. Please try again.' }, { status: 500 })
  }
}

// ─── POST ──────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isDemoMode()) {
    return NextResponse.json({ error: 'Not available in demo mode' }, { status: 400 })
  }

  let body: CreateBody
  try {
    body = await req.json() as CreateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const description = typeof body.description === 'string' ? body.description.trim() : ''
  if (!description) {
    return NextResponse.json({ error: 'Description is required' }, { status: 400 })
  }
  if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount < 0) {
    return NextResponse.json({ error: 'Amount must be a number greater than or equal to 0' }, { status: 400 })
  }
  const amount = round2(body.amount)

  let incurredOn: string
  if (body.incurred_on !== undefined) {
    if (typeof body.incurred_on !== 'string' || !isValidDateString(body.incurred_on)) {
      return NextResponse.json({ error: 'incurred_on must be a valid date (YYYY-MM-DD)' }, { status: 400 })
    }
    incurredOn = body.incurred_on
  } else {
    incurredOn = new Date().toISOString().slice(0, 10)
  }

  const tradeCategoryId = body.trade_category_id ?? null
  if (tradeCategoryId !== null && !isValidTradeCategoryId(tradeCategoryId)) {
    return NextResponse.json({ error: 'trade_category_id must be a valid trade' }, { status: 400 })
  }

  const { jobId } = params

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    if (!(await jobOwnedByBuilder(supabase, jobId, builderId))) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const { data, error } = await supabase
      .from('job_cost_entries')
      .insert({
        job_id: jobId,
        builder_id: builderId,
        trade_category_id: tradeCategoryId,
        description,
        amount,
        incurred_on: incurredOn,
      })
      .select('id')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ created: true, cost_id: data!.id })
  } catch (err) {
    console.error('[jobs/costs:post] error:', err)
    return NextResponse.json({ error: 'Failed to log cost — please try again.' }, { status: 500 })
  }
}
