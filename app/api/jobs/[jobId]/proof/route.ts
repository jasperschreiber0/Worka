import { NextRequest, NextResponse } from 'next/server'
import { getJobProofEvents, verifyProofChain } from '@/lib/proof'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

// ─── GET /api/jobs/[jobId]/proof ──────────────────────────────────────────────
// Full WorkA Proof trail for a job, most recent first, with hash-chain status.

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { jobId } = params

  const events = await getJobProofEvents(jobId, builderId)
  const chain = verifyProofChain(events)

  return NextResponse.json({
    events,
    total: events.length,
    chain,
  })
}
