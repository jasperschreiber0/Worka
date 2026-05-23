import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth/role-guard'

// ─── In-memory demo quote status map ─────────────────────────────────────────
// Shared across requests within the same server process.

const demoQuoteStatusMap: Map<string, { status: string; sent_at: string | null }> = new Map([
  ['demo-quote-id', { status: 'pending_review', sent_at: null }],
])

// ─── Request body ─────────────────────────────────────────────────────────────

interface ConfirmSendBody {
  builder_id: string
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
  const communicationId = generateCommunicationId()

  // ── Send via Resend if API key is set ─────────────────────────────────────

  const resendApiKey = process.env.RESEND_API_KEY
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
      console.error('Resend error:', err)
      return NextResponse.json({ error: 'Failed to send email' }, { status: 502 })
    }
  }

  // ── Update quote status (demo in-memory or Supabase) ──────────────────────

  if (quoteId === 'demo-quote-id') {
    demoQuoteStatusMap.set(quoteId, { status: 'sent', sent_at: sentAt })
  } else {
    // Real Supabase path:
    // await supabase.from('quotes').update({ status: 'sent', sent_at: sentAt }).eq('id', quoteId)
    // For now, return 404 for non-demo quotes
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
  }

  // ── Log to communication_history (demo in-memory) ─────────────────────────
  // In a real implementation this would insert into the communication_history table:
  //
  // await supabase.from('communication_history').insert({
  //   job_id: quote.job_id,
  //   builder_id: body.builder_id,
  //   direction: 'outbound',
  //   channel: 'email',
  //   subject: body.subject,
  //   body: body.body,
  //   to_address: body.to,
  //   from_address: 'quotes@worka.com.au',
  //   timestamp: sentAt,
  // })
  //
  // For demo mode we skip DB and return the generated id.

  const response: ConfirmSendResponse = {
    sent: true,
    sent_at: sentAt,
    communication_id: communicationId,
  }

  return NextResponse.json(response, { status: 200 })
}
