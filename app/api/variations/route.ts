import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { DEMO_VARIATIONS, demoVariationState, type DemoVariation } from '@/lib/variations-demo'
import { requirePermission } from '@/lib/auth/role-guard'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { recordProofEvent } from '@/lib/proof'
import { isValidTradeCategoryId } from '@/lib/trade-taxonomy'

function formatAud(amount: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(amount)
}

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
  // Required (not optional) — quote_line_items.trade_category_id is NOT
  // NULL, so a variation needs one from creation onward to ever become a
  // quote line item on approval. See migration 098's own comment for why
  // this is nullable at the DB level (pre-existing rows) despite being
  // required here for every newly-raised variation.
  trade_category_id: number
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
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' } as never, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
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
      .select('id, job_id, builder_id, title, description, amount, status, created_at, approved_at, approved_by, variation_ref, labour_cost, materials_cost, trade_category_id')
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
  const denied = await requirePermission(request, 'approve_variation')
  if (denied) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // builder_id always comes from the authenticated session — never from the
  // request body — so a caller can't create a variation under a fake identity.
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: CreateVariationBody
  try {
    body = await request.json() as CreateVariationBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { job_id, title, description, amount, trade_category_id } = body
  if (!job_id || !title || !description || amount === undefined) {
    return NextResponse.json(
      { error: 'job_id, title, description, and amount are required' },
      { status: 400 }
    )
  }
  if (typeof trade_category_id !== 'number' || !isValidTradeCategoryId(trade_category_id)) {
    return NextResponse.json({ error: 'A valid trade category is required' }, { status: 400 })
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
    .select('id, address')
    .eq('id', job_id)
    .eq('builder_id', builderId)
    .single()

  if (!jobRow) {
    return NextResponse.json({ error: 'Job not found or unauthorized' }, { status: 404 })
  }

  const { data: variation, error } = await supabase
    .from('variations')
    .insert({
      job_id,
      builder_id: builderId,
      title,
      description,
      amount,
      labour_cost: body.labour_cost ?? null,
      materials_cost: body.materials_cost ?? null,
      trade_category_id,
      status: 'draft',
    })
    .select()
    .single()

  if (error || !variation) {
    console.error('[POST /api/variations]', error)
    return NextResponse.json({ error: error?.message ?? 'Failed to create variation' }, { status: 500 })
  }

  await recordProofEvent({
    jobId: job_id,
    builderId,
    eventType: 'variation_submitted',
    description: `Variation raised: ${title} (${formatAud(amount)})${jobRow.address ? ` — ${jobRow.address}` : ''}`,
    metadata: { variation_id: variation.id, amount },
  })

  return NextResponse.json({ variation }, { status: 201 })
}
