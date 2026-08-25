import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { DEMO_VARIATIONS, demoVariationState, type DemoVariation } from '@/lib/variations-demo'
import { requirePermission } from '@/lib/auth/role-guard'
import { recordProofEvent } from '@/lib/proof'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { applyApprovedVariationToQuote, type ApplyVariationResult } from '@/lib/variations'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ResolveRequestBody {
  action: 'approved' | 'rejected'
}

interface NotificationDraft {
  subject: string
  body: string
}

interface ResolveResponse {
  variation: DemoVariation
  notification_draft: NotificationDraft | null
  requires_builder_approval: boolean
  /** Whether the approved variation was applied to the quote (Contract
   *  Value / Current Margin) — null when action wasn't 'approved'. */
  contract_effect: ApplyVariationResult | null
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

function buildNotificationDraft(variation: DemoVariation, builderName: string, businessName: string): NotificationDraft {
  const subject = `Variation approved — ${variation.job_address}`
  const body = `Hi there,

Your variation request has been approved.

${variation.title}
Amount: $${variation.amount.toLocaleString('en-AU')}

This amount will be added to your final invoice.

${builderName}
${businessName}`

  return { subject, body }
}

// ─── POST /api/variations/[variationId]/resolve ───────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ variationId: string }> }
): Promise<NextResponse<ResolveResponse | ErrorResponse>> {
  const body = await request.json() as ResolveRequestBody
  const { action } = body
  if (action !== 'approved' && action !== 'rejected') {
    return NextResponse.json({ error: 'action must be "approved" or "rejected"' }, { status: 400 })
  }

  const requiredAction = action === 'approved' ? 'approve_variation' : 'reject_variation'
  const denied = await requirePermission(request, requiredAction)
  if (denied) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { variationId } = await params
  const now = new Date().toISOString()

  if (isDemoMode()) {
    const base = DEMO_VARIATIONS.find((v) => v.id === variationId && v.builder_id === builderId)
    if (!base) {
      return NextResponse.json({ error: 'Variation not found' }, { status: 404 })
    }

    const current = applyState(base)
    // Forward-only: rejected/approved variations cannot be re-decided
    if (current.status === 'rejected' || current.status === 'approved') {
      return NextResponse.json(
        { error: `Variation is already ${current.status} — status cannot be changed.` },
        { status: 422 }
      )
    }

    demoVariationState.set(variationId, {
      status: action,
      approved_at: action === 'approved' ? now : undefined,
      approved_by: action === 'approved' ? builderId : undefined,
    })

    const updated = applyState(base)

    await recordProofEvent({
      jobId: base.job_id,
      builderId,
      eventType: action === 'approved' ? 'variation_approved' : 'variation_rejected',
      description: `Variation ${base.variation_ref ?? base.id} ${action}: ${base.title} ($${base.amount.toLocaleString('en-AU')})`,
      metadata: { variation_id: base.id, amount: base.amount, decided_at: now },
    })

    const notificationDraft =
      action === 'approved' ? buildNotificationDraft(updated, 'Dave Nguyen', 'Dave Nguyen Building') : null

    return NextResponse.json({
      variation: updated,
      notification_draft: notificationDraft,
      requires_builder_approval: action === 'approved',
      // Demo mode has no real quote/quote_line_items to apply this to.
      contract_effect: null,
    })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }
  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

  // Atomic, forward-only update — only succeeds while still draft/pending.
  const { data: updatedRows, error } = await sb
    .from('variations')
    .update({ status: action, approved_at: action === 'approved' ? now : null, approved_by: action === 'approved' ? builderId : null })
    .eq('id', variationId)
    .eq('builder_id', builderId)
    .in('status', ['draft', 'pending'])
    .select('id, job_id, builder_id, title, description, amount, status, created_at, approved_at, approved_by, variation_ref, labour_cost, materials_cost, submitted_by, trade_category_id')

  const updatedRow = (updatedRows as (DemoVariation & { variation_ref: string | null; trade_category_id: number | null })[] | null)?.[0]
  if (error || !updatedRow) {
    const { data: existing } = await sb
      .from('variations')
      .select('status')
      .eq('id', variationId)
      .eq('builder_id', builderId)
      .single()
    if (!existing) return NextResponse.json({ error: 'Variation not found' }, { status: 404 })
    return NextResponse.json(
      { error: `Variation is already ${(existing as { status: string }).status} — status cannot be changed.` },
      { status: 422 }
    )
  }

  const { data: job } = await sb.from('jobs').select('address').eq('id', updatedRow.job_id).single()
  const jobAddress = (job as { address: string } | null)?.address ?? 'your job'
  const updated: DemoVariation = { ...updatedRow, job_address: jobAddress, created_display: 'recently' }

  await recordProofEvent({
    jobId: updatedRow.job_id,
    builderId,
    eventType: action === 'approved' ? 'variation_approved' : 'variation_rejected',
    description: `Variation ${updatedRow.variation_ref ?? updatedRow.id} ${action}: ${updatedRow.title} ($${updatedRow.amount.toLocaleString('en-AU')})`,
    metadata: { variation_id: updatedRow.id, amount: updatedRow.amount, decided_at: now },
  })

  const notificationDraft =
    action === 'approved' ? buildNotificationDraft(updated, 'Dave Nguyen', 'Dave Nguyen Building') : null

  // The financial connection this milestone exists for — only ever attempted
  // when this exact request performed the draft/pending -> approved
  // transition above (never on a retry, which already failed the atomic
  // update and returned 422 before reaching this line).
  const contractEffect = action === 'approved'
    ? await applyApprovedVariationToQuote(sb, {
        id: updatedRow.id,
        job_id: updatedRow.job_id,
        title: updatedRow.title,
        amount: updatedRow.amount,
        trade_category_id: updatedRow.trade_category_id,
      })
    : null

  return NextResponse.json({
    variation: updated,
    notification_draft: notificationDraft,
    requires_builder_approval: action === 'approved',
    contract_effect: contractEffect,
  })
}
