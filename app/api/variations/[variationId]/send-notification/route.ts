import { NextRequest, NextResponse } from 'next/server'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SendNotificationRequestBody {
  builder_id: string
  to: string
  subject: string
  body: string
}

interface SendNotificationResponse {
  sent: boolean
  sent_at: string
  communication_id: string
}

interface ErrorResponse {
  error: string
}

// ─── POST /api/variations/[variationId]/send-notification ─────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ variationId: string }> }
): Promise<NextResponse<SendNotificationResponse | ErrorResponse>> {
  const { variationId } = await params

  let body: SendNotificationRequestBody
  try {
    body = (await request.json()) as SendNotificationRequestBody
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { to, subject, body: emailBody } = body

  if (!to || !subject || !emailBody) {
    return NextResponse.json({ error: 'Missing required fields: to, subject, body' }, { status: 400 })
  }

  const sentAt = new Date().toISOString()
  const communicationId = `comm-var-${variationId}-${Date.now()}`

  // If Resend API key is available, send via Resend
  const resendKey = process.env.RESEND_API_KEY
  if (resendKey) {
    try {
      const resendResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'WorkA <noreply@worka.app>',
          to: [to],
          subject,
          text: emailBody,
        }),
      })

      if (!resendResponse.ok) {
        const err = await resendResponse.json() as { message?: string }
        console.error('[send-notification] Resend error:', err)
        return NextResponse.json({ error: err.message ?? 'Failed to send notification via Resend' }, { status: 500 })
      }
    } catch (err) {
      console.error('[send-notification] Resend fetch error:', err)
      return NextResponse.json({ error: 'Failed to send notification' }, { status: 500 })
    }
  }

  // Log to communication_history (demo: just acknowledge)
  // In live mode, insert into Supabase communication_history table:
  // await supabase.from('communication_history').insert({ ... })

  return NextResponse.json({
    sent: true,
    sent_at: sentAt,
    communication_id: communicationId,
  })
}
