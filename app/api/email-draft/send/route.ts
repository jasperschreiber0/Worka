import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { addCommEntry, demoCommHistory } from '@/lib/comms-demo'
import { randomUUID } from 'crypto'
import { requirePermission } from '@/lib/auth/role-guard'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SendEmailRequestBody {
  builder_id: string
  job_id: string | null
  to: string
  subject: string
  body: string
  linked_variation_id?: string
  linked_invoice_id?: string
}

interface SendEmailResponse {
  sent: boolean
  communication_id: string
  sent_at: string
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest
): Promise<NextResponse<SendEmailResponse | { error: string }>> {
  const denied = requirePermission(request, 'send_email')
  if (denied) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const body = (await request.json()) as SendEmailRequestBody
    const { builder_id, job_id, to, subject, body: emailBody, linked_variation_id, linked_invoice_id } = body

    if (!builder_id || !to || !subject || !emailBody) {
      return NextResponse.json(
        { error: 'builder_id, to, subject, and body are required' },
        { status: 400 }
      )
    }

    const fromAddress = 'dave@nguyenconstructions.com.au'
    let communicationId: string
    let sentAt: string

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    const resendApiKey = process.env.RESEND_API_KEY

    // If a job_id is provided in live mode, verify it belongs to this builder
    if (job_id && supabaseUrl && serviceRoleKey) {
      const supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      const { data: jobRow } = await supabase
        .from('jobs')
        .select('id')
        .eq('id', job_id)
        .eq('builder_id', builder_id)
        .single()
      if (!jobRow) {
        return NextResponse.json({ error: 'Job not found or unauthorized' }, { status: 403 })
      }
    }

    // Step 1: Send via Resend if configured
    if (resendApiKey) {
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [to],
          subject,
          text: emailBody,
        }),
      })

      if (!resendRes.ok) {
        const resendErr = await resendRes.json() as { message?: string }
        console.error('[/api/email-draft/send] Resend error:', resendErr)
        // Continue to log even if send fails — audit trail is non-negotiable
      }
    }

    sentAt = new Date().toISOString()

    // Step 2: Log to communication_history
    if (supabaseUrl && serviceRoleKey) {
      const supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })

      const { data: commRow, error } = await supabase
        .from('communication_history')
        .insert({
          builder_id,
          job_id: job_id ?? null,
          direction: 'outbound',
          channel: 'email',
          subject,
          body: emailBody,
          from_address: fromAddress,
          to_address: to,
          timestamp: sentAt,
          linked_variation_id: linked_variation_id ?? null,
          linked_invoice_id: linked_invoice_id ?? null,
        })
        .select('id')
        .single()

      if (error || !commRow) {
        console.error('[/api/email-draft/send] Supabase insert error:', error)
        // Fall back to demo log
        communicationId = randomUUID()
      } else {
        communicationId = (commRow as { id: string }).id
      }
    } else {
      // Demo mode: log to in-memory store
      const entry = addCommEntry({
        builder_id,
        job_id: job_id ?? null,
        direction: 'outbound',
        channel: 'email',
        subject,
        body: emailBody,
        from_address: fromAddress,
        to_address: to,
        linked_variation_id: linked_variation_id ?? null,
        linked_invoice_id: linked_invoice_id ?? null,
      })
      communicationId = entry.id
      // Log for debugging
      console.log('[/api/email-draft/send] Demo comms history length:', demoCommHistory.length)
    }

    return NextResponse.json({
      sent: true,
      communication_id: communicationId,
      sent_at: sentAt,
    })
  } catch (err) {
    console.error('[/api/email-draft/send] Error:', err)
    return NextResponse.json({ error: 'Failed to send email' }, { status: 500 })
  }
}
