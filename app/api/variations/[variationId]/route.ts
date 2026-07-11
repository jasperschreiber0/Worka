import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { DEMO_VARIATIONS, demoVariationState, type DemoVariation } from '@/lib/variations-demo'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { recordProofEvent } from '@/lib/proof'

// ─── Response type ────────────────────────────────────────────────────────────

interface VariationResponse {
  variation: DemoVariation
}

interface ErrorResponse {
  error: string
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

interface RealVariationRow {
  id: string
  job_id: string
  builder_id: string
  title: string
  description: string
  amount: number
  status: DemoVariation['status']
  created_at: string
  approved_at: string | null
  approved_by: string | null
  variation_ref: string | null
  labour_cost: number | null
  materials_cost: number | null
  submitted_by: string | null
  share_token_hash: string | null
  share_token_expires_at: string | null
}

function realVariationSb() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) return null
  return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
}

function toVariationResponse(row: RealVariationRow, jobAddress: string): DemoVariation {
  return {
    id: row.id,
    job_id: row.job_id,
    job_address: jobAddress,
    builder_id: row.builder_id,
    title: row.title,
    description: row.description,
    amount: row.amount,
    status: row.status,
    created_at: row.created_at,
    created_display: 'recently',
    approved_at: row.approved_at,
    approved_by: row.approved_by,
    variation_ref: row.variation_ref ?? undefined,
    labour_cost: row.labour_cost ?? undefined,
    materials_cost: row.materials_cost ?? undefined,
    submitted_by: row.submitted_by ?? undefined,
  }
}

/**
 * Verifies a client-supplied share token against the stored hash + expiry.
 * Returns the row only when the token is present, matches, and hasn't expired —
 * this is the sole authorization check for the public approval page.
 */
async function loadByShareToken(variationId: string, token: string): Promise<RealVariationRow | null> {
  const sb = realVariationSb()
  if (!sb) return null

  const { data } = await sb
    .from('variations')
    .select('id, job_id, builder_id, title, description, amount, status, created_at, approved_at, approved_by, variation_ref, labour_cost, materials_cost, submitted_by, share_token_hash, share_token_expires_at')
    .eq('id', variationId)
    .single()

  const row = data as RealVariationRow | null
  if (!row || !row.share_token_hash) return null

  const tokenHash = createHash('sha256').update(token).digest('hex')
  if (tokenHash !== row.share_token_hash) return null

  if (row.share_token_expires_at && new Date(row.share_token_expires_at).getTime() < Date.now()) {
    return null
  }

  return row
}

// ─── GET /api/variations/[variationId] ────────────────────────────────────────
// Two callers, two auth models:
//   - Builder-side (chat/VariationCard): authenticated session, no token.
//   - Public client-approval page: no session, must present a valid ?t= token.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ variationId: string }> }
): Promise<NextResponse<VariationResponse | ErrorResponse>> {
  const { variationId } = await params
  const token = request.nextUrl.searchParams.get('t')

  if (token) {
    if (isDemoMode()) {
      const base = DEMO_VARIATIONS.find((v) => v.id === variationId)
      if (!base) return NextResponse.json({ error: 'Variation not found' }, { status: 404 })
      return NextResponse.json({ variation: applyState(base) })
    }

    const row = await loadByShareToken(variationId, token)
    if (!row) return NextResponse.json({ error: 'Variation not found' }, { status: 404 })

    const sb = realVariationSb()
    const { data: job } = await sb
      ? await sb!.from('jobs').select('address').eq('id', row.job_id).single()
      : { data: null }
    const jobAddress = (job as { address: string } | null)?.address ?? 'your job'

    return NextResponse.json({ variation: toVariationResponse(row, jobAddress) })
  }

  // No token presented — fall back to the authenticated builder-side view.
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isDemoMode()) {
    const base = DEMO_VARIATIONS.find((v) => v.id === variationId && v.builder_id === builderId)
    if (!base) return NextResponse.json({ error: 'Variation not found' }, { status: 404 })
    return NextResponse.json({ variation: applyState(base) })
  }

  const sb = realVariationSb()
  if (!sb) return NextResponse.json({ error: 'Not configured' }, { status: 503 })

  const { data } = await sb
    .from('variations')
    .select('id, job_id, builder_id, title, description, amount, status, created_at, approved_at, approved_by, variation_ref, labour_cost, materials_cost, submitted_by')
    .eq('id', variationId)
    .eq('builder_id', builderId)
    .single()

  const row = data as RealVariationRow | null
  if (!row) return NextResponse.json({ error: 'Variation not found' }, { status: 404 })

  const { data: job } = await sb.from('jobs').select('address').eq('id', row.job_id).single()
  const jobAddress = (job as { address: string } | null)?.address ?? 'your job'

  return NextResponse.json({ variation: toVariationResponse(row, jobAddress) })
}

// ─── PATCH /api/variations/[variationId] — client approves/rejects ────────────
// Public endpoint by design (the client never logs in), so the share token is
// the only thing standing between "anyone with a UUID" and "only whoever
// received this specific, expiring, single-variation link." Forward-only:
// once a variation is approved or rejected, it can never be re-decided here.

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ variationId: string }> }
): Promise<NextResponse<VariationResponse | ErrorResponse>> {
  const { variationId } = await params
  const body = await request.json() as { status?: string; approved_by?: string; t?: string }
  const status = body.status as DemoVariation['status']
  if (status !== 'approved' && status !== 'rejected') {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  if (isDemoMode()) {
    const base = DEMO_VARIATIONS.find((v) => v.id === variationId)
    if (!base) return NextResponse.json({ error: 'Variation not found' }, { status: 404 })

    const current = applyState(base)
    if (current.status === 'approved' || current.status === 'rejected') {
      return NextResponse.json({ error: `Variation is already ${current.status}.` }, { status: 422 })
    }

    demoVariationState.set(variationId, {
      status,
      approved_at: new Date().toISOString(),
      approved_by: body.approved_by ?? 'Client',
    })

    return NextResponse.json({ variation: applyState(base) })
  }

  const token = body.t ?? request.nextUrl.searchParams.get('t')
  if (!token) {
    return NextResponse.json({ error: 'Missing or invalid link' }, { status: 401 })
  }

  const row = await loadByShareToken(variationId, token)
  if (!row) {
    return NextResponse.json({ error: 'Missing or invalid link' }, { status: 401 })
  }

  if (row.status === 'approved' || row.status === 'rejected') {
    return NextResponse.json({ error: `Variation is already ${row.status}.` }, { status: 422 })
  }

  const sb = realVariationSb()!
  const now = new Date().toISOString()
  const approvedBy = (body.approved_by ?? 'Client').slice(0, 200)

  // Atomic, forward-only update — only succeeds if status is still draft/pending,
  // so two concurrent submissions of the same link can't both "win".
  const { data: updatedRows, error } = await sb
    .from('variations')
    .update({ status, approved_at: now, approved_by: approvedBy })
    .eq('id', variationId)
    .in('status', ['draft', 'pending'])
    .select('id, job_id, builder_id, title, description, amount, status, created_at, approved_at, approved_by, variation_ref, labour_cost, materials_cost, submitted_by')

  const updated = (updatedRows as RealVariationRow[] | null)?.[0]
  if (error || !updated) {
    return NextResponse.json({ error: `Variation is already ${row.status}.` }, { status: 422 })
  }

  await recordProofEvent({
    jobId: updated.job_id,
    builderId: updated.builder_id,
    eventType: status === 'approved' ? 'variation_approved' : 'variation_rejected',
    description: `Client ${status} variation ${updated.variation_ref ?? updated.id}: ${updated.title} (approved by ${approvedBy})`,
    metadata: { variation_id: updated.id, amount: updated.amount, decided_at: now },
  })

  const { data: job } = await sb.from('jobs').select('address').eq('id', updated.job_id).single()
  const jobAddress = (job as { address: string } | null)?.address ?? 'your job'

  return NextResponse.json({ variation: toVariationResponse(updated, jobAddress) })
}
