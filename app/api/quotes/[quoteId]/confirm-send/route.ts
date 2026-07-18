import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { addCommEntry } from '@/lib/comms-demo'
import { requirePermission } from '@/lib/auth/role-guard'
import { randomUUID } from 'crypto'
import { recordProofEvent } from '@/lib/proof'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

// Quote job IDs for proof recording in demo mode
const DEMO_QUOTE_JOB_MAP: Record<string, string> = {
  'demo-quote-id': '00000000-0000-0000-0000-000000000011',
  'demo-quote-id-toorak': '00000000-0000-0000-0000-000000000011',
}

// ─── In-memory demo quote status map ─────────────────────────────────────────

const demoQuoteStatusMap: Map<string, { status: string; sent_at: string | null }> = new Map([
  ['demo-quote-id', { status: 'pending_review', sent_at: null }],
  ['demo-quote-id-toorak', { status: 'pending_review', sent_at: null }],
])

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConfirmSendBody {
  builder_id: string
  to: string
  subject: string
  body: string
}

interface ConfirmSendResponse {
  sent: true
  sent_at: string
  communication_id: string
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { quoteId: string } }
): Promise<NextResponse> {
  const denied = await requirePermission(request, 'send_quote')
  if (denied) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { quoteId } = params

  let body: ConfirmSendBody
  try {
    body = await request.json() as ConfirmSendBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const sessionBuilderId = await getAuthenticatedBuilderId()
  if (!sessionBuilderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!body.to || !body.subject || !body.body) {
    return NextResponse.json({ error: 'to, subject, and body are required' }, { status: 400 })
  }

  const sentAt = new Date().toISOString()
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const resendApiKey = process.env.RESEND_API_KEY

  // ── Demo path ─────────────────────────────────────────────────────────────

  const isDemoQuote = !supabaseUrl || !serviceRoleKey || quoteId.startsWith('demo-')
  if (isDemoQuote) {
    const current = demoQuoteStatusMap.get(quoteId)
    if (!current) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }
    if (current.status !== 'pending_review') {
      return NextResponse.json(
        { error: `Quote is already ${current.status} — cannot send again` },
        { status: 422 }
      )
    }
    demoQuoteStatusMap.set(quoteId, { status: 'sent', sent_at: sentAt })
    const commId = randomUUID()
    addCommEntry({
      builder_id: sessionBuilderId,
      job_id: null,
      direction: 'outbound',
      channel: 'email',
      subject: body.subject,
      body: body.body,
      from_address: 'quotes@getworka.com',
      to_address: body.to,
      linked_variation_id: null,
      linked_invoice_id: null,
    })

    // WorkA Proof: quote dispatch is dispute evidence — record it automatically
    const demoJobId = DEMO_QUOTE_JOB_MAP[quoteId]
    if (demoJobId) {
      await recordProofEvent({
        jobId: demoJobId,
        builderId: sessionBuilderId,
        eventType: 'quote_sent',
        description: `Quote sent to ${body.to} for approval — "${body.subject}"`,
        metadata: { quote_id: quoteId, to: body.to, subject: body.subject, communication_id: commId },
      })
    }

    return NextResponse.json<ConfirmSendResponse>({ sent: true, sent_at: sentAt, communication_id: commId })
  }

  // ── Live path: Supabase ───────────────────────────────────────────────────

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // 1. Verify quote exists and belongs to this builder
  const { data: quoteRow, error: fetchErr } = await supabase
    .from('quotes')
    .select('id, status, job_id')
    .eq('id', quoteId)
    .eq('builder_id', sessionBuilderId)
    .single()

  if (fetchErr || !quoteRow) {
    return NextResponse.json({ error: 'Quote not found or unauthorized' }, { status: 404 })
  }

  // 2. Forward-only state guard — only pending_review can be sent
  if (quoteRow.status !== 'pending_review') {
    return NextResponse.json(
      { error: `Quote is already ${quoteRow.status} — cannot send again` },
      { status: 422 }
    )
  }

  // 3. Pricing safety — the last server-side line of defense before a real
  // email reaches a real client. An included line item with no total is
  // silently contributing $0; the quoted price is understated and must not
  // go out. (Same shared isSilentlyUnpriced rule the quote GET and the
  // draft route apply — this re-checks against the DB at send time in case
  // anything changed since the draft was built.)
  {
    const { data: lineItems } = await supabase
      .from('quote_line_items')
      .select('description, total, is_assumption, assumption_status')
      .eq('quote_id', quoteId)
    const { isSilentlyUnpriced } = await import('@/lib/estimating/readiness')
    const unpriced = ((lineItems ?? []) as Array<{ description: string; total: number | null; is_assumption: boolean; assumption_status: string | null }>)
      .filter((li) => isSilentlyUnpriced(li))
    if (unpriced.length > 0) {
      const names = unpriced.slice(0, 3).map((li) => `"${li.description}"`).join(', ')
      return NextResponse.json(
        {
          error: `Cannot send: ${unpriced.length} item${unpriced.length !== 1 ? 's' : ''} (${names}${unpriced.length > 3 ? ', …' : ''}) have no price and add $0 to the total. Set a rate or exclude them first.`,
        },
        { status: 422 }
      )
    }
  }

  // 4. Atomic claim FIRST, then email. Previously the Resend call ran before
  // the eq('status','pending_review') guard, so two near-simultaneous
  // requests (double-click, client retry) could both dispatch a real email
  // to the client before one of them lost the status race — the client got
  // two identical quotes and WorkA Proof recorded one send. Claiming the
  // status transition first means the loser of the race never emails at all.
  const { data: updated } = await supabase
    .from('quotes')
    .update({ status: 'sent', sent_at: sentAt })
    .eq('id', quoteId)
    .eq('status', 'pending_review')
    .select('id')
    .single()

  if (!updated) {
    return NextResponse.json(
      { error: 'Quote status changed concurrently — refresh and try again' },
      { status: 409 }
    )
  }

  // 5. Send via Resend — with the claim held. If delivery fails, roll the
  // claim back (a compensating rollback of our own claim, not a user-facing
  // backwards transition: guarded on this request's own sent_at so it can
  // never revert someone else's later legitimate send) so the builder can
  // fix the problem and try again instead of the quote being marked sent
  // with no email ever delivered.
  if (resendApiKey) {
    try {
      const { Resend } = await import('resend')
      const resend = new Resend(resendApiKey)
      await resend.emails.send({
        from: 'quotes@getworka.com',
        to: body.to,
        subject: body.subject,
        text: body.body,
      })
    } catch (err) {
      console.error('[confirm-send] Resend error:', err)
      const { error: rollbackErr } = await supabase
        .from('quotes')
        .update({ status: 'pending_review', sent_at: null })
        .eq('id', quoteId)
        .eq('status', 'sent')
        .eq('sent_at', sentAt)
      if (rollbackErr) {
        console.error('[confirm-send] rollback after email failure ALSO failed — quote is marked sent without a delivered email:', rollbackErr.message, { quoteId })
      }
      return NextResponse.json({ error: 'The email failed to send — nothing was delivered to the client. Please try again.' }, { status: 502 })
    }
  }

  // 6. Log to communication_history
  const { data: commRow } = await supabase
    .from('communication_history')
    .insert({
      builder_id: sessionBuilderId,
      job_id: quoteRow.job_id ?? null,
      direction: 'outbound',
      channel: 'email',
      subject: body.subject,
      body: body.body,
      from_address: 'quotes@getworka.com',
      to_address: body.to,
      timestamp: sentAt,
    })
    .select('id')
    .single()

  const communicationId = (commRow as { id: string } | null)?.id ?? randomUUID()

  // WorkA Proof: quote sent to client is the key evidence in a payment dispute
  await recordProofEvent({
    jobId: quoteRow.job_id,
    builderId: sessionBuilderId,
    eventType: 'quote_sent',
    description: `Quote sent to ${body.to} for approval — "${body.subject}"`,
    metadata: { quote_id: quoteId, to: body.to, subject: body.subject, communication_id: communicationId },
  })

  return NextResponse.json<ConfirmSendResponse>({
    sent: true,
    sent_at: sentAt,
    communication_id: communicationId,
  })
}
