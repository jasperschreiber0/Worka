import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { DEMO_VARIATIONS, demoVariationState, type DemoVariation } from '@/lib/variations-demo'
import { requirePermission } from '@/lib/auth/role-guard'

// ─── Response type ────────────────────────────────────────────────────────────

interface VariationsResponse {
  variations: DemoVariation[]
  pending_count: number
  total_amount_pending: number
}

interface CreateVariationBody {
  builder_id: string
  job_id: string
  title: string
  description: string
  amount: number
  labour_cost?: number
  materials_cost?: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function applyState(variation: DemoVariation): DemoVariation {
  const override = demoVariationState.get(variation.id)
  if (!override) return variation
  return {
    ...variation,
    status: override.status as DemoVariation['status'],
    approved_at: override.approved_at ?? null,
    approved_by: override.approved_by ?? null,
  }
}

// ─── GET /api/variations ──────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<VariationsResponse>> {
  const { searchParams } = new URL(request.url)
  const builderId = searchParams.get('builder_id')
  const jobId = searchParams.get('job_id')
  const status = searchParams.get('status')

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (supabaseUrl && serviceRoleKey && builderId) {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    let query = supabase
      .from('variations')
      .select('id, job_id, builder_id, title, description, amount, status, created_at, approved_at, approved_by, variation_ref, labour_cost, materials_cost')
      .eq('builder_id', builderId)
      .order('created_at', { ascending: false })

    if (jobId) query = query.eq('job_id', jobId)
    if (status) query = query.eq('status', status)

    const { data: rows, error } = await query
    if (error) {
      return NextResponse.json({ variations: [], pending_count: 0, total_amount_pending: 0 })
    }

    const variations = (rows ?? []) as DemoVariation[]
    const pending = variations.filter(v => v.status === 'pending')
    return NextResponse.json({
      variations,
      pending_count: pending.length,
      total_amount_pending: pending.reduce((sum, v) => sum + v.amount, 0),
    })
  }

  // Demo fallback
  let variations = DEMO_VARIATIONS.map(applyState)
  if (builderId) variations = variations.filter(v => v.builder_id === builderId)
  if (jobId) variations = variations.filter(v => v.job_id === jobId)
  if (status) variations = variations.filter(v => v.status === status)
  const pending = variations.filter(v => v.status === 'pending')

  return NextResponse.json({
    variations,
    pending_count: pending.length,
    total_amount_pending: pending.reduce((sum, v) => sum + v.amount, 0),
  })
}

// ─── POST /api/variations ─────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = requirePermission(request, 'approve_variation')
  if (denied) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: CreateVariationBody
  try {
    body = await request.json() as CreateVariationBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { builder_id, job_id, title, description, amount } = body
  if (!builder_id || !job_id || !title || !description || amount === undefined) {
    return NextResponse.json(
      { error: 'builder_id, job_id, title, description, and amount are required' },
      { status: 400 }
    )
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: 'Variations cannot be created in demo mode' }, { status: 503 })
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Verify job belongs to this builder
  const { data: jobRow } = await supabase
    .from('jobs')
    .select('id')
    .eq('id', job_id)
    .eq('builder_id', builder_id)
    .single()

  if (!jobRow) {
    return NextResponse.json({ error: 'Job not found or unauthorized' }, { status: 404 })
  }

  const { data: variation, error } = await supabase
    .from('variations')
    .insert({
      job_id,
      builder_id,
      title,
      description,
      amount,
      labour_cost: body.labour_cost ?? null,
      materials_cost: body.materials_cost ?? null,
      status: 'draft',
    })
    .select()
    .single()

  if (error || !variation) {
    console.error('[POST /api/variations]', error)
    return NextResponse.json({ error: error?.message ?? 'Failed to create variation' }, { status: 500 })
  }

  return NextResponse.json({ variation }, { status: 201 })
}
