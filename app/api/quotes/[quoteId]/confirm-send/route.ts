import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { addCommEntry } from '@/lib/comms-demo'
import { requirePermission } from '@/lib/auth/role-guard'
import { randomUUID } from 'crypto'

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
  const denied = requirePermission(request, 'send_quote')
  if (denied) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { quoteId } = params

  let body: ConfirmSendBody
  try {
    body = await request.json() as ConfirmSendBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.builder_id) {
    return NextResponse.json({ error: 'builder_id is required' }, { status: 400 })
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
      builder_id: body.builder_id,
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
    .eq('builder_id', body.builder_id)
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

  // 3. Send via Resend
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
      return NextResponse.json({ error: 'Failed to send email' }, { status: 502 })
    }
  }

  // 4. Atomic status update — eq('status', 'pending_review') prevents double-sends
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

  // 5. Log to communication_history
  const { data: commRow } = await supabase
    .from('communication_history')
    .insert({
      builder_id: body.builder_id,
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

  return NextResponse.json<ConfirmSendResponse>({
    sent: true,
    sent_at: sentAt,
    communication_id: communicationId,
  })
}
