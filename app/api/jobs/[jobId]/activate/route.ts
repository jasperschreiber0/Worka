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
import { recordProofEvent } from '@/lib/proof'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { applyMargin, calculateClientPrice, DEFAULT_MARGIN_PCT } from '@/lib/pricing'
import { planActivationRepair } from '@/lib/job-activation'
import { randomUUID } from 'crypto'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActivateRequestBody {
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
  const denied = await requirePermission(request, 'activate_job')
  if (denied) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const builder_id = await getAuthenticatedBuilderId()
  if (!builder_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = (await request.json()) as ActivateRequestBody
    const { quote_id } = body
    const { jobId } = params

    if (!quote_id) {
      return NextResponse.json(
        { error: 'quote_id is required' },
        { status: 400 }
      )
    }

    if (isDemoMode()) {
      return handleDemoActivation(jobId, quote_id, builder_id)
    }

    // A real DB failure here must surface as a real error — silently
    // falling back to demo activation would tell the builder their job is
    // active when nothing was actually written.
    return await handleLiveActivation(jobId, quote_id, builder_id)
  } catch (err) {
    console.error('[/api/jobs/[jobId]/activate] Error:', err)
    return NextResponse.json(
      { error: 'Activation failed — please try again.' },
      { status: 500 }
    )
  }
}

// ─── Demo mode activation ─────────────────────────────────────────────────────

async function handleDemoActivation(
  jobId: string,
  quoteId: string,
  builderId: string
): Promise<NextResponse> {
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

  // Generate activation data — invoice amounts from the client contract
  // value (cost + margin), matching the real-mode path's margin rule.
  const milestones = generateMilestones(jobId, quote.total_cost)
  const invoiceSchedule = generateInvoiceSchedule(jobId, applyMargin(quote.total_cost, DEFAULT_MARGIN_PCT))
  const now = new Date().toISOString()

  const recorded = await recordProofEvent({
    jobId,
    builderId,
    eventType: 'job_activated',
    description: `Job activated — work begins on ${job.address}`,
    metadata: {
      quote_id: quoteId,
      total_cost: quote.total_cost,
      milestone_count: milestones.length,
      invoice_schedule_count: invoiceSchedule.length,
    },
  })

  const firstProofEvent: DemoProofEvent = recorded ?? {
    id: randomUUID(),
    job_id: jobId,
    event_type: 'job_activated',
    description: `Job activated — work begins on ${job.address}`,
    metadata: { quote_id: quoteId, total_cost: quote.total_cost },
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
    .select('id, job_id, status, total_cost, margin_pct, version, is_current')
    .eq('id', quoteId)
    .eq('builder_id', builderId)
    .single()

  if (quoteError || !quoteRow) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
  }

  const quote = quoteRow as { id: string; job_id: string; status: string; total_cost: number; margin_pct: number | null; version: number; is_current: boolean }

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

  // 3. Atomic forward-only activation claim. The .in('status', ...) filter is
  // the guard: a job already active (double-click, client retry, a second
  // sent quote for the same job) matches zero rows here, so the second call
  // gets a clean 409 instead of re-inserting a full duplicate set of
  // milestones/invoices and re-feeding rate learning (Safety Rule #3 —
  // "write guards on every status-change function" — previously missing on
  // exactly this transition).
  const { data: claimedJob } = await supabase
    .from('jobs')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .in('status', ['quoting', 'quoted'])
    .select('id')
    .single()

  // FIX (production risk audit, post-Job-Closeout-v1): steps 4-6 below used
  // to be unchecked writes — a mid-sequence failure could leave
  // jobs.status='active' with none of the quote-approval/milestones/
  // invoice-schedule persisted, while still returning 200. Because the
  // claim above is one-shot and forward-only, a naive retry could never
  // re-claim the job to fix that. planActivationRepair (lib/job-activation.ts)
  // decides, from real DB state only, whether a job already 'active' is
  // genuinely fully activated (unchanged 409 below) or demonstrably
  // incomplete (resume only the missing steps, never duplicate what's
  // already persisted).
  let plan: ReturnType<typeof planActivationRepair>

  if (!claimedJob) {
    if (job.status !== 'active') {
      // complete/archived — unchanged behaviour.
      return NextResponse.json(
        { error: `Job is already ${job.status} — activation can only run once` },
        { status: 409 }
      )
    }

    // Job is already 'active'. Only ever resumes for the job's actual
    // canonical quote (quotes.is_current, migration 061) — a stray/
    // non-canonical quote_id gets the same unchanged 409 rather than an
    // invented repair for an ambiguous case.
    const [
      { count: milestoneCount, error: milestoneCountErr },
      { count: scheduleCount, error: scheduleCountErr },
    ] = await Promise.all([
      supabase.from('job_milestones').select('id', { count: 'exact', head: true }).eq('job_id', jobId),
      supabase.from('invoice_schedule').select('id', { count: 'exact', head: true }).eq('job_id', jobId),
    ])

    if (milestoneCountErr || scheduleCountErr) {
      console.error(JSON.stringify({
        event: 'activate_repair_state_check_failed', job_id: jobId, quote_id: quoteId,
        milestone_error: milestoneCountErr?.message, schedule_error: scheduleCountErr?.message,
      }))
      return NextResponse.json({ error: 'Activation failed while checking job state — please try again.' }, { status: 500 })
    }

    const repairPlan = planActivationRepair({
      isCurrentQuote: quote.is_current,
      quoteApproved: quote.status === 'approved',
      milestoneCount: milestoneCount ?? 0,
      scheduleCount: scheduleCount ?? 0,
    })

    if (!repairPlan.allowRepair || repairPlan.fullyComplete) {
      // Genuinely fully activated already (or an ambiguous non-canonical
      // quote_id) — unchanged behaviour, no writes.
      return NextResponse.json(
        { error: 'Job is already active — activation can only run once' },
        { status: 409 }
      )
    }

    plan = repairPlan
  } else {
    // Fresh claim: the job was 'quoting'/'quoted' a moment ago, so nothing
    // downstream could possibly exist yet — every step runs, exactly as
    // before this fix, just now error-checked.
    plan = { allowRepair: true, fullyComplete: false, needsQuoteApproval: true, needsMilestones: true, needsInvoiceSchedule: true }
  }

  // 4. Update quote status to approved (guarded the same way — never
  // re-approves or reverses a terminal quote). Skipped when a repair finds
  // this already done by a prior attempt.
  if (plan.needsQuoteApproval) {
    const { error: quoteUpdateErr } = await supabase
      .from('quotes')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', quoteId)
      .in('status', ['sent', 'approved'])

    if (quoteUpdateErr) {
      console.error(JSON.stringify({
        event: 'activate_quote_approval_failed', job_id: jobId, quote_id: quoteId, error: quoteUpdateErr.message,
      }))
      return NextResponse.json({ error: 'Activation failed while approving the quote — please try again.' }, { status: 500 })
    }

    // 4b. Tier 1 rate learning — fold this accepted quote's rates into
    // builder_learned_rates (best-effort, never blocks activation). Tied
    // specifically to THIS call performing the quote-approval transition,
    // so a job already approved by an earlier attempt never gets it re-run
    // — preserving the original "never double-count" guarantee even though
    // a later call may now legitimately resume other missing steps.
    const { captureLearnedRates } = await import('@/lib/pricing')
    const learnedRatesStartedAt = Date.now()
    await captureLearnedRates(supabase, quoteId)
    console.log(JSON.stringify({
      event: 'activate_capture_learned_rates', quote_id: quoteId, job_id: jobId,
      duration_ms: Date.now() - learnedRatesStartedAt,
    }))
  }

  // The client pays cost + margin. quotes.total_cost is the builder's
  // internal cost basis (see CLAUDE.md's Margin rule) — every client-facing
  // figure must be marked up, and invoice-schedule amounts are exactly that:
  // the progress claims the client will be billed. Generating them from raw
  // total_cost (as this used to) meant every activated job invoiced the
  // client at cost, silently forfeiting the builder's entire margin.
  //
  // Canonical: sum of each line item's OWN margin_pct-marked-up total, never
  // total_cost * quote.margin_pct — that blanket formula ignores provisional
  // sums' 0% margin and disagreed with the client_price the builder actually
  // reviewed in QuoteView before approving this quote. See calculateClientPrice
  // (lib/pricing.ts) for the full reasoning. Invoice schedules must match the
  // approved quote exactly, so this must be the same calculation, not a
  // second, independently-derived one.
  //
  // GST: this value is GST-EXCLUSIVE, matching every other client-facing
  // figure in the app (see lib/pricing.ts's PRICE_BASIS_LABEL/
  // CLIENT_PRICE_DISCLAIMER for the product decision this reflects). If
  // invoice_schedule amounts are ever surfaced to a builder or client
  // without also surfacing that disclaimer, that surface needs the same
  // labeling QuoteView/PDF export/send-quote already carry — do not assume
  // it's implied.
  const { data: activationLineItems } = await supabase
    .from('quote_line_items')
    .select('total, margin_pct, assumption_status')
    .eq('quote_id', quoteId)
  const clientContractValue = calculateClientPrice(activationLineItems ?? [])

  // 5. Generate and insert milestones — checked, and skipped (reading back
  // what's already there instead) when a repair finds this already done.
  let milestones: ReturnType<typeof generateMilestones>
  if (plan.needsMilestones) {
    milestones = generateMilestones(jobId, quote.total_cost)
    const { error: milestoneInsertErr } = await supabase.from('job_milestones').insert(
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

    if (milestoneInsertErr) {
      console.error(JSON.stringify({
        event: 'activate_milestone_insert_failed', job_id: jobId, quote_id: quoteId, error: milestoneInsertErr.message,
      }))
      return NextResponse.json({ error: 'Activation failed while creating milestones — please try again.' }, { status: 500 })
    }
  } else {
    const { data: existingMilestones, error: milestoneReadErr } = await supabase
      .from('job_milestones')
      .select('id, job_id, title, description, due_date, completed_at, sort_order')
      .eq('job_id', jobId)
      .order('sort_order', { ascending: true })

    if (milestoneReadErr || !existingMilestones) {
      console.error(JSON.stringify({
        event: 'activate_milestone_readback_failed', job_id: jobId, quote_id: quoteId, error: milestoneReadErr?.message,
      }))
      return NextResponse.json({ error: 'Activation failed while confirming milestones — please try again.' }, { status: 500 })
    }

    milestones = (existingMilestones as {
      id: string; job_id: string; title: string; description: string | null
      due_date: string | null; completed_at: string | null; sort_order: number
    }[]).map((m) => ({
      id: m.id,
      job_id: m.job_id,
      title: m.title,
      description: m.description,
      due_date: m.due_date,
      due_display: null,
      completed_at: m.completed_at,
      sort_order: m.sort_order,
    }))
  }

  // 6. Generate and insert invoice schedule — from the CLIENT contract value
  // (cost + margin), never raw cost. See the margin note above step 5. Same
  // checked-and-skip-if-already-persisted pattern as milestones.
  let invoiceSchedule: ReturnType<typeof generateInvoiceSchedule>
  if (plan.needsInvoiceSchedule) {
    invoiceSchedule = generateInvoiceSchedule(jobId, clientContractValue)
    const { error: scheduleInsertErr } = await supabase.from('invoice_schedule').insert(
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

    if (scheduleInsertErr) {
      console.error(JSON.stringify({
        event: 'activate_invoice_schedule_insert_failed', job_id: jobId, quote_id: quoteId, error: scheduleInsertErr.message,
      }))
      return NextResponse.json({ error: 'Activation failed while creating the invoice schedule — please try again.' }, { status: 500 })
    }
  } else {
    const { data: existingSchedule, error: scheduleReadErr } = await supabase
      .from('invoice_schedule')
      .select('id, job_id, label, percentage, amount, due_trigger, invoice_id')
      .eq('job_id', jobId)

    if (scheduleReadErr || !existingSchedule) {
      console.error(JSON.stringify({
        event: 'activate_invoice_schedule_readback_failed', job_id: jobId, quote_id: quoteId, error: scheduleReadErr?.message,
      }))
      return NextResponse.json({ error: 'Activation failed while confirming the invoice schedule — please try again.' }, { status: 500 })
    }

    invoiceSchedule = existingSchedule
  }

  // 7. Create first proof event (hash-chained via the proof engine)
  const now = new Date().toISOString()
  const recorded = await recordProofEvent({
    jobId,
    builderId,
    eventType: 'job_activated',
    description: `Job activated — work begins on ${job.address}`,
    metadata: {
      quote_id: quoteId,
      total_cost: quote.total_cost,
      milestone_count: milestones.length,
      invoice_schedule_count: invoiceSchedule.length,
    },
  })

  const firstProofEvent: DemoProofEvent = recorded ?? {
    id: randomUUID(),
    job_id: jobId,
    event_type: 'job_activated',
    description: `Job activated — work begins on ${job.address}`,
    metadata: { quote_id: quoteId, total_cost: quote.total_cost },
    created_at: now,
    display_time: formatDisplayTime(now),
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
