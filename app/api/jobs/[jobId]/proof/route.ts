import { NextRequest, NextResponse } from 'next/server'
import { getJobProofEvents, verifyProofChain } from '@/lib/proof'

// ─── GET /api/jobs/[jobId]/proof ──────────────────────────────────────────────
// Full WorkA Proof trail for a job, most recent first, with hash-chain status.

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const { jobId } = params

  const events = await getJobProofEvents(jobId)
  const chain = verifyProofChain(events)

  return NextResponse.json({
    events,
    total: events.length,
    chain,
  })
}
