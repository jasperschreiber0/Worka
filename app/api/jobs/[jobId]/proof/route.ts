import { NextRequest, NextResponse } from 'next/server'
import { demoActivationState, formatDisplayTime, type DemoProofEvent } from '@/lib/activation-demo'

// ─── Demo communication history as proof events ───────────────────────────────

interface CommsProofEntry {
  job_id: string
  event_type: string
  description: string
  created_at: string
}

const DEMO_COMMS_EVENTS: Record<string, CommsProofEntry[]> = {
  '00000000-0000-0000-0000-000000000011': [
    {
      job_id: '00000000-0000-0000-0000-000000000011',
      event_type: 'quote_sent',
      description: 'Quote for $127,500 sent to Tom Caruso',
      created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ],
  '00000000-0000-0000-0000-000000000020': [
    {
      job_id: '00000000-0000-0000-0000-000000000020',
      event_type: 'quote_sent',
      description: 'Quote for $127,500 sent to Tom Caruso',
      created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ],
  '00000000-0000-0000-0000-000000000010': [
    {
      job_id: '00000000-0000-0000-0000-000000000010',
      event_type: 'invoice_sent',
      description: 'Invoice for $28,000 sent to the Hendersons',
      created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      job_id: '00000000-0000-0000-0000-000000000010',
      event_type: 'variation_pending',
      description: 'Variation requested: Upgrade kitchen benchtop to 40mm Caesarstone ($3,200)',
      created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ],
}

// ─── GET /api/jobs/[jobId]/proof ──────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const { jobId } = params

  // Collect proof events from activation state
  const activationState = demoActivationState.get(jobId)
  const activationEvents: DemoProofEvent[] = activationState?.proof_events ?? []

  // Collect comms-derived events for this job
  const commsEntries = DEMO_COMMS_EVENTS[jobId] ?? []
  const commsEvents: DemoProofEvent[] = commsEntries.map((entry) => ({
    id: `comms-${entry.job_id}-${entry.event_type}`,
    job_id: entry.job_id,
    event_type: entry.event_type,
    description: entry.description,
    metadata: null,
    created_at: entry.created_at,
    display_time: formatDisplayTime(entry.created_at),
  }))

  // Merge and sort by created_at descending (most recent first)
  const allEvents: DemoProofEvent[] = [...activationEvents, ...commsEvents].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )

  return NextResponse.json({
    events: allEvents,
    total: allEvents.length,
  })
}
