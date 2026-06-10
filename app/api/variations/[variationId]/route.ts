import { NextRequest, NextResponse } from 'next/server'
import { DEMO_VARIATIONS, demoVariationState, type DemoVariation } from '@/lib/variations-demo'

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

// ─── GET /api/variations/[variationId] ────────────────────────────────────────

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ variationId: string }> }
): Promise<NextResponse<VariationResponse | ErrorResponse>> {
  const { variationId } = await params
  const base = DEMO_VARIATIONS.find((v) => v.id === variationId)

  if (!base) {
    return NextResponse.json({ error: 'Variation not found' }, { status: 404 })
  }

  return NextResponse.json({ variation: applyState(base) })
}

// ─── PATCH /api/variations/[variationId] — client approves/rejects ────────────

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ variationId: string }> }
): Promise<NextResponse<VariationResponse | ErrorResponse>> {
  const { variationId } = await params
  const base = DEMO_VARIATIONS.find((v) => v.id === variationId)

  if (!base) {
    return NextResponse.json({ error: 'Variation not found' }, { status: 404 })
  }

  const body = await request.json() as { status?: string; approved_by?: string }
  const status = body.status as DemoVariation['status']
  if (status !== 'approved' && status !== 'rejected') {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  demoVariationState.set(variationId, {
    status,
    approved_at: new Date().toISOString(),
    approved_by: body.approved_by ?? 'Client',
  })

  return NextResponse.json({ variation: applyState(base) })
}
