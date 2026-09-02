import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { DEMO_VARIATIONS } from '@/lib/variations-demo'
import { recordProofEvent } from '@/lib/proof'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'

async function findVariation(variationId: string, builderId: string): Promise<{ job_id: string; title: string } | null> {
  if (isDemoMode()) {
    const v = DEMO_VARIATIONS.find((v) => v.id === variationId && v.builder_id === builderId)
    return v ? { job_id: v.job_id, title: v.title } : null
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) return null

  const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  const { data } = await sb
    .from('variations')
    .select('job_id, title')
    .eq('id', variationId)
    .eq('builder_id', builderId)
    .single()

  return data as { job_id: string; title: string } | null
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SendNotificationRequestBody {
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
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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

  // Ownership check before anything leaves the building
  const variation = await findVariation(variationId, builderId)
  if (!variation) {
    return NextResponse.json({ error: 'Variation not found' }, { status: 404 })
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
          from: `WorkA <${process.env.EMAIL_FROM_ADDRESS ?? 'hello@getworka.com'}>`,
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

  if (!isDemoMode()) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (supabaseUrl && serviceRoleKey) {
      const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
      const { error: commsError } = await sb.from('communication_history').insert({
        builder_id: builderId,
        job_id: variation.job_id,
        direction: 'outbound',
        channel: 'email',
        to_address: to,
        subject,
        body: emailBody,
        timestamp: sentAt,
        linked_variation_id: variationId,
      })
      if (commsError) console.error('[send-notification] communication_history insert failed:', commsError)
    }
  }

  // WorkA Proof: client notification is the evidence that matters in a
  // payment dispute — record that it went out, to whom, and when
  await recordProofEvent({
    jobId: variation.job_id,
    builderId,
    eventType: 'variation_notice_sent',
    description: `Variation approval notice for "${variation.title}" emailed to ${to}`,
    metadata: {
      variation_id: variationId,
      to,
      subject,
      communication_id: communicationId,
    },
  })

  return NextResponse.json({
    sent: true,
    sent_at: sentAt,
    communication_id: communicationId,
  })
}
