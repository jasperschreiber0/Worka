import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requirePermission } from '@/lib/auth/role-guard'
import {
  demoActivationState,
  generateMilestones,
  generateInvoiceSchedule,
  formatDisplayTime,
  type DemoProofEvent,
} from '@/lib/activation-demo'
import { randomUUID } from 'crypto'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActivateRequestBody {
  builder_id: string
  quote_id: string
}

interface ActivateResponse {
  job: { id: string; address: string; status: 'active' }
  quote: { id: string; status: 'approved'; total_cost: number }
  milestones: ReturnType<typeof generateMilestones>
  invoice_schedule: ReturnType<typeof generateInvoiceSchedule>
  first_proof_event: DemoProofEvent
  activated_at: string
}

// ─── Demo job/quote data ──────────────────────────────────────────────────────

interface DemoJobRecord {
  id: string
  address: string
  status: string
  builder_id: string
}

interface DemoQuoteRecord {
  id: string
  job_id: string
  status: string
  total_cost: number
  version: number
}

const DEMO_JOBS: Record<string, DemoJobRecord> = {
  '00000000-0000-0000-0000-000000000011': {
    id: '00000000-0000-0000-0000-000000000011',
    address: '8 Burnside Rd, Toorak VIC 3142',
    status: 'quoted',
    builder_id: '00000000-0000-0000-0000-000000000001',
  },
  '00000000-0000-0000-0000-000000000020': {
    id: '00000000-0000-0000-0000-000000000020',
    address: '8 Burnside Rd, Toorak VIC 3142',
    status: 'quoted',
    builder_id: '00000000-0000-0000-0000-000000000001',
  },
  '00000000-0000-0000-0000-000000000010': {
    id: '00000000-0000-0000-0000-000000000010',
    address: '14 Merri St, Fitzroy VIC 3065',
    status: 'active',
    builder_id: '00000000-0000-0000-0000-000000000001',
  },
}

const DEMO_QUOTES: Record<string, DemoQuoteRecord> = {
  'demo-quote-id-toorak': {
    id: 'demo-quote-id-toorak',
    job_id: '00000000-0000-0000-0000-000000000011',
    status: 'sent',
    total_cost: 127500,
    version: 1,
  },
}

// ─── POST /api/jobs/[jobId]/activate ─────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const denied = requirePermission(request, 'activate_job')
  if (denied) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const body = (await request.json()) as ActivateRequestBody
    const { builder_id, quote_id } = body
    const { jobId } = params

    if (!builder_id || !quote_id) {
      return NextResponse.json(
        { error: 'builder_id and quote_id are required' },
        { status: 400 }
      )
    }

    const isDemoMode =
      !process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL === 'your-supabase-url'

    if (isDemoMode) {
      return handleDemoActivation(jobId, quote_id, builder_id)
    }

    try {
      return await handleLiveActivation(jobId, quote_id, builder_id)
    } catch {
      // DB unavailable — fall back to demo activation so the flow still works
      return handleDemoActivation(jobId, quote_id, builder_id)
    }
  } catch (err) {
    console.error('[/api/jobs/[jobId]/activate] Error:', err)
    return NextResponse.json(
      { error: 'Activation failed — please try again.' },
      { status: 500 }
    )
  }
}

// ─── Demo mode activation ─────────────────────────────────────────────────────

function handleDemoActivation(
  jobId: string,
  quoteId: string,
  _builderId: string
): NextResponse {
  // Look up the job (allow any known job ID)
  const job = DEMO_JOBS[jobId]
  if (!job) {
    return NextResponse.json(
      { error: `Job ${jobId} not found` },
      { status: 404 }
    )
  }

  // Look up the quote — fall back to the Toorak quote for any Toorak job
  let quote = DEMO_QUOTES[quoteId]
  if (!quote) {
    // If the quote_id isn't in our demo map, try to synthesise one
    const isToorakJob =
      jobId === '00000000-0000-0000-0000-000000000011' ||
      jobId === '00000000-0000-0000-0000-000000000020'
    if (isToorakJob) {
      quote = {
        id: quoteId,
        job_id: jobId,
        status: 'sent',
        total_cost: 127500,
        version: 1,
      }
    } else {
      return NextResponse.json(
        { error: `Quote ${quoteId} not found` },
        { status: 404 }
      )
    }
  }

  // Validate quote status — must be sent or approved
  if (quote.status !== 'sent' && quote.status !== 'approved') {
    return NextResponse.json(
      { error: 'Job can only be activated when quote is sent or approved' },
      { status: 422 }
    )
  }

  // Check if already activated
  const existingState = demoActivationState.get(jobId)
  if (existingState?.activated) {
    // Return existing state (idempotent)
    const firstEvent = existingState.proof_events[0]
    return NextResponse.json({
      job: { id: jobId, address: job.address, status: 'active' },
      quote: { id: quoteId, status: 'approved', total_cost: quote.total_cost },
      milestones: existingState.milestones,
      invoice_schedule: existingState.invoice_schedule,
      first_proof_event: firstEvent,
      activated_at: 'just now',
    } satisfies ActivateResponse)
  }

  // Generate activation data
  const milestones = generateMilestones(jobId, quote.total_cost)
  const invoiceSchedule = generateInvoiceSchedule(jobId, quote.total_cost)
  const now = new Date().toISOString()

  const firstProofEvent: DemoProofEvent = {
    id: randomUUID(),
    job_id: jobId,
    event_type: 'job_activated',
    description: `Job activated — work begins on ${job.address}`,
    metadata: {
      quote_id: quoteId,
      total_cost: quote.total_cost,
      milestone_count: milestones.length,
      invoice_schedule_count: invoiceSchedule.length,
    },
    created_at: now,
    display_time: 'just now',
  }

  // Persist to in-memory state
  demoActivationState.set(jobId, {
    activated: true,
    activated_at: now,
    milestones,
    invoice_schedule: invoiceSchedule,
    proof_events: [firstProofEvent],
  })

  // Also set state for the alias IDs
  if (jobId === '00000000-0000-0000-0000-000000000011') {
    demoActivationState.set('00000000-0000-0000-0000-000000000020', {
      activated: true,
      activated_at: now,
      milestones,
      invoice_schedule: invoiceSchedule,
      proof_events: [firstProofEvent],
    })
  } else if (jobId === '00000000-0000-0000-0000-000000000020') {
    demoActivationState.set('00000000-0000-0000-0000-000000000011', {
      activated: true,
      activated_at: now,
      milestones,
      invoice_schedule: invoiceSchedule,
      proof_events: [firstProofEvent],
    })
  }

  return NextResponse.json({
    job: { id: jobId, address: job.address, status: 'active' },
    quote: { id: quoteId, status: 'approved', total_cost: quote.total_cost },
    milestones,
    invoice_schedule: invoiceSchedule,
    first_proof_event: firstProofEvent,
    activated_at: 'just now',
  } satisfies ActivateResponse)
}

// ─── Live Supabase activation ─────────────────────────────────────────────────

async function handleLiveActivation(
  jobId: string,
  quoteId: string,
  builderId: string
): Promise<NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // 1. Fetch and validate the quote
  const { data: quoteRow, error: quoteError } = await supabase
    .from('quotes')
    .select('id, job_id, status, total_cost, version')
    .eq('id', quoteId)
    .eq('builder_id', builderId)
    .single()

  if (quoteError || !quoteRow) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
  }

  const quote = quoteRow as { id: string; job_id: string; status: string; total_cost: number; version: number }

  if (quote.status !== 'sent' && quote.status !== 'approved') {
    return NextResponse.json(
      { error: 'Job can only be activated when quote is sent or approved' },
      { status: 422 }
    )
  }

  // 2. Fetch the job
  const { data: jobRow, error: jobError } = await supabase
    .from('jobs')
    .select('id, address, status')
    .eq('id', jobId)
    .eq('builder_id', builderId)
    .single()

  if (jobError || !jobRow) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const job = jobRow as { id: string; address: string; status: string }

  // 3. Update job status to active
  await supabase
    .from('jobs')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', jobId)

  // 4. Update quote status to approved
  await supabase
    .from('quotes')
    .update({ status: 'approved' })
    .eq('id', quoteId)

  // 5. Generate and insert milestones
  const milestones = generateMilestones(jobId, quote.total_cost)
  await supabase.from('job_milestones').insert(
    milestones.map((m) => ({
      id: m.id,
      job_id: m.job_id,
      builder_id: builderId,
      title: m.title,
      description: m.description,
      due_date: m.due_date,
      completed_at: null,
      sort_order: m.sort_order,
    }))
  )

  // 6. Generate and insert invoice schedule
  const invoiceSchedule = generateInvoiceSchedule(jobId, quote.total_cost)
  await supabase.from('invoice_schedule').insert(
    invoiceSchedule.map((item) => ({
      id: item.id,
      job_id: item.job_id,
      builder_id: builderId,
      label: item.label,
      percentage: item.percentage,
      amount: item.amount,
      due_trigger: item.due_trigger,
      invoice_id: null,
    }))
  )

  // 7. Create first proof event
  const now = new Date().toISOString()
  const firstProofEvent: DemoProofEvent = {
    id: randomUUID(),
    job_id: jobId,
    event_type: 'job_activated',
    description: `Job activated — work begins on ${job.address}`,
    metadata: {
      quote_id: quoteId,
      total_cost: quote.total_cost,
      milestone_count: milestones.length,
      invoice_schedule_count: invoiceSchedule.length,
    },
    created_at: now,
    display_time: formatDisplayTime(now),
  }

  await supabase.from('proof_events').insert({
    id: firstProofEvent.id,
    job_id: jobId,
    builder_id: builderId,
    event_type: firstProofEvent.event_type,
    description: firstProofEvent.description,
    metadata: firstProofEvent.metadata,
  })

  return NextResponse.json({
    job: { id: jobId, address: job.address, status: 'active' },
    quote: { id: quoteId, status: 'approved', total_cost: quote.total_cost },
    milestones,
    invoice_schedule: invoiceSchedule,
    first_proof_event: firstProofEvent,
    activated_at: 'just now',
  } satisfies ActivateResponse)
}
