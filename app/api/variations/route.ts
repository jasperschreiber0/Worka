import { NextRequest, NextResponse } from 'next/server'
import { DEMO_VARIATIONS, demoVariationState, type DemoVariation } from '@/lib/variations-demo'

// ─── Response type ────────────────────────────────────────────────────────────

interface VariationsResponse {
  variations: DemoVariation[]
  pending_count: number
  total_amount_pending: number
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

  let variations = DEMO_VARIATIONS.map(applyState)

  // Filter by builder
  if (builderId) {
    variations = variations.filter((v) => v.builder_id === builderId)
  }

  // Filter by job
  if (jobId) {
    variations = variations.filter((v) => v.job_id === jobId)
  }

  // Filter by status
  if (status) {
    variations = variations.filter((v) => v.status === status)
  }

  const pending = variations.filter((v) => v.status === 'pending')

  return NextResponse.json({
    variations,
    pending_count: pending.length,
    total_amount_pending: pending.reduce((sum, v) => sum + v.amount, 0),
  })
}
