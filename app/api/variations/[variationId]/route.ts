import { NextRequest, NextResponse } from 'next/server'
import { DEMO_VARIATIONS, demoVariationState, type DemoVariation } from '@/lib/variations-demo'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

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
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { variationId } = await params
  const base = DEMO_VARIATIONS.find((v) => v.id === variationId && v.builder_id === builderId)

  if (!base) {
    return NextResponse.json({ error: 'Variation not found' }, { status: 404 })
  }

  return NextResponse.json({ variation: applyState(base) })
}
