import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth/role-guard'
import { recordProofEvent } from '@/lib/proof'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'

// The demo quote belongs to the Toorak job
const DEMO_QUOTE_JOB_ID = '00000000-0000-0000-0000-000000000011'

// ─── In-memory demo quote status map ─────────────────────────────────────────
// Shared across requests within the same server process.

const demoQuoteStatusMap: Map<string, { status: string; sent_at: string | null }> = new Map([
  ['demo-quote-id', { status: 'pending_review', sent_at: null }],
])

// ─── Request body ─────────────────────────────────────────────────────────────

interface ConfirmSendBody {
  to: string
  subject: string
  body: string
}

// ─── Response shape ───────────────────────────────────────────────────────────

interface ConfirmSendResponse {
  sent: true
  sent_at: string
  communication_id: string
}

// ─── Generate a mock communication id ─────────────────────────────────────────

function generateCommunicationId(): string {
  return `comm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

// ─── Send the approved draft via Resend ───────────────────────────────────────

async function sendViaResend(to: string, subject: string, text: string): Promise<{ ok: boolean }> {
  const resendApiKey = process.env.RESEND_API_KEY
  if (!resendApiKey) return { ok: true } // demo / not configured — skip delivery

  try {
    const { Resend } = await import('resend')
    const resend = new Resend(resendApiKey)
    await resend.emails.send({
      from: 'quotes@worka.com.au',
      to,
      subject,
      text,
    })
    return { ok: true }
  } catch (err) {
    console.error('Resend error:', err)
    return { ok: false }
  }
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { quoteId: string } }
): Promise<NextResponse> {
  const denied = requirePermission(request, 'send_quote')
  if (denied) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { quoteId } = params

  let body: ConfirmSendBody
  try {
    body = await request.json() as ConfirmSendBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.to || !body.subject || !body.body) {
    return NextResponse.json({ error: 'to, subject, and body are required' }, { status: 400 })
  }

  const sentAt = new Date().toISOString()

  // ── Demo mode ──────────────────────────────────────────────────────────────

  if (isDemoMode()) {
    if (quoteId !== 'demo-quote-id') {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }

    const communicationId = generateCommunicationId()
    const delivery = await sendViaResend(body.to, body.subject, body.body)
    if (!delivery.ok) {
      return NextResponse.json({ error: 'Failed to send email' }, { status: 502 })
    }

    demoQuoteStatusMap.set(quoteId, { status: 'sent', sent_at: sentAt })

    // WorkA Proof: quote dispatch is recorded automatically
    await recordProofEvent({
      jobId: DEMO_QUOTE_JOB_ID,
      builderId,
      eventType: 'quote_sent',
      description: `Quote sent to ${body.to} for approval — "${body.subject}"`,
      metadata: {
        quote_id: quoteId,
        to: body.to,
        subject: body.subject,
        communication_id: communicationId,
      },
    })

    const response: ConfirmSendResponse = {
      sent: true,
      sent_at: sentAt,
      communication_id: communicationId,
    }
    return NextResponse.json(response, { status: 200 })
  }

  // ── Real mode: Supabase ────────────────────────────────────────────────────

  const { createClient } = await import('@supabase/supabase-js')
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Verify the quote exists, belongs to this builder, and is awaiting send
  const { data: quoteRow, error: quoteErr } = await supabase
    .from('quotes')
    .select('id, job_id, status, total_cost')
    .eq('id', quoteId)
    .eq('builder_id', builderId)
    .single()

  if (quoteErr || !quoteRow) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
  }
  if (quoteRow.status !== 'pending_review') {
    return NextResponse.json(
      { error: `Quote cannot be sent — current status is '${quoteRow.status}'. Only quotes in 'pending_review' can be sent.` },
      { status: 422 }
    )
  }

  const delivery = await sendViaResend(body.to, body.subject, body.body)
  if (!delivery.ok) {
    return NextResponse.json({ error: 'Failed to send email' }, { status: 502 })
  }

  // Forward-only: only pending_review → sent; a concurrent send loses the race
  const { data: updatedRows, error: updateErr } = await supabase
    .from('quotes')
    .update({ status: 'sent', sent_at: sentAt })
    .eq('id', quoteId)
    .eq('builder_id', builderId)
    .eq('status', 'pending_review')
    .select('id')

  if (updateErr || !updatedRows || updatedRows.length === 0) {
    console.error('Quote status update failed after send:', updateErr)
    return NextResponse.json(
      { error: 'Email sent but quote status update failed — check the quote before resending.' },
      { status: 500 }
    )
  }

  // Log the outbound email (best-effort)
  const { data: commRow, error: commErr } = await supabase
    .from('communication_history')
    .insert({
      job_id: quoteRow.job_id,
      builder_id: builderId,
      direction: 'outbound',
      channel: 'email',
      subject: body.subject,
      body: body.body,
      to_address: body.to,
      from_address: 'quotes@worka.com.au',
      timestamp: sentAt,
    })
    .select('id')
    .single()
  if (commErr) {
    console.error('communication_history insert failed:', commErr)
  }

  // WorkA Proof: quote dispatch is recorded automatically
  await recordProofEvent({
    jobId: quoteRow.job_id,
    builderId,
    eventType: 'quote_sent',
    description: `Quote sent to ${body.to} for approval — "${body.subject}"`,
    metadata: {
      quote_id: quoteId,
      to: body.to,
      subject: body.subject,
      total_cost: quoteRow.total_cost,
      communication_id: commRow?.id ?? null,
    },
  })

  const response: ConfirmSendResponse = {
    sent: true,
    sent_at: sentAt,
    communication_id: commRow?.id ?? generateCommunicationId(),
  }

  return NextResponse.json(response, { status: 200 })
}
