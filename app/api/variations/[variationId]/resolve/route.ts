import { NextRequest, NextResponse } from 'next/server'
import { DEMO_VARIATIONS, demoVariationState, type DemoVariation } from '@/lib/variations-demo'
import { requirePermission } from '@/lib/auth/role-guard'
import { recordProofEvent } from '@/lib/proof'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ResolveRequestBody {
  builder_id: string
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
  const denied = requirePermission(request, requiredAction)
  if (denied) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { variationId } = await params
  const base = DEMO_VARIATIONS.find((v) => v.id === variationId)

  if (!base) {
    return NextResponse.json({ error: 'Variation not found' }, { status: 404 })
  }

  const current = applyState(base)

  // Forward-only: rejected variations cannot become pending again
  if (current.status === 'rejected' || current.status === 'approved') {
    return NextResponse.json(
      { error: `Variation is already ${current.status} — status cannot be changed.` },
      { status: 422 }
    )
  }

  const now = new Date().toISOString()

  // Update in-memory state
  demoVariationState.set(variationId, {
    status: action,
    approved_at: action === 'approved' ? now : undefined,
    approved_by: action === 'approved' ? body.builder_id : undefined,
  })

  const updated = applyState(base)

  // WorkA Proof: the approval decision is evidence — record it automatically
  await recordProofEvent({
    jobId: base.job_id,
    builderId: body.builder_id,
    eventType: action === 'approved' ? 'variation_approved' : 'variation_rejected',
    description: `Variation ${base.variation_ref ?? base.id} ${action}: ${base.title} ($${base.amount.toLocaleString('en-AU')})`,
    metadata: {
      variation_id: base.id,
      amount: base.amount,
      decided_at: now,
    },
  })

  // Prepare notification draft for approved variations — held for builder review, never auto-sent
  const notificationDraft =
    action === 'approved'
      ? buildNotificationDraft(updated, 'Dave Nguyen', 'Dave Nguyen Building')
      : null

  return NextResponse.json({
    variation: updated,
    notification_draft: notificationDraft,
    requires_builder_approval: action === 'approved',
  })
}
