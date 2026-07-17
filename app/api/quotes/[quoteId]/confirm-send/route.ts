import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { addCommEntry } from '@/lib/comms-demo'
import { requirePermission } from '@/lib/auth/role-guard'
import { randomUUID } from 'crypto'
import { recordProofEvent } from '@/lib/proof'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import {
  loadQuoteQualityGate,
  loadDemoQuoteQualityGate,
  decideQuoteSendPolicy,
  buildRiskAcknowledgementSnapshot,
} from '@/lib/estimating/quote-quality-policy'
import type { QualityGateResult } from '@/lib/estimating/quality-gate'
import type { RiskAcknowledgementSnapshot } from '@/lib/types/database.types'

// Quote job IDs for proof recording in demo mode. Trust Workflow Demo
// Fixture: 'demo-fitzroy-quote' (READY) added alongside the existing two —
// see lib/quote-demo.ts's getDemoQuoteById for the quote data itself.
const DEMO_QUOTE_JOB_MAP: Record<string, string> = {
  'demo-quote-id': '00000000-0000-0000-0000-000000000011',
  'demo-quote-id-toorak': '00000000-0000-0000-0000-000000000011',
  'demo-fitzroy-quote': '00000000-0000-0000-0000-000000000010',
}

// ─── In-memory demo quote status map ─────────────────────────────────────────

const demoQuoteStatusMap: Map<string, { status: string; sent_at: string | null }> = new Map([
  ['demo-quote-id', { status: 'pending_review', sent_at: null }],
  ['demo-quote-id-toorak', { status: 'pending_review', sent_at: null }],
  ['demo-fitzroy-quote', { status: 'pending_review', sent_at: null }],
])

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConfirmSendBody {
  builder_id: string
  to: string
  subject: string
  body: string
  /** Required when the quality gate is REVIEW_REQUIRED — the builder has
   * seen the specific risks/exposure and consciously accepts them. Ignored
   * (and never needed) when the gate is READY; rejected as insufficient
   * when the gate is BLOCKED — no acknowledgement can bypass that state. */
  risk_acknowledged?: boolean
}

interface ConfirmSendResponse {
  sent: true
  sent_at: string
  communication_id: string
}

/** Returned on 422 when the quality gate prevents sending, so the client can
 * render the specific reasons (BLOCKED) or the acceptance screen (REVIEW_REQUIRED). */
interface QualityGateBlockedResponse {
  error: string
  quality_gate: QualityGateResult
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

    // Same shared loader + policy decision as real mode — never trust a
    // client-side quality_gate read earlier.
    const { quote: demoQuoteForGate, gate: demoGate } = loadDemoQuoteQualityGate(quoteId)
    const demoDecision = decideQuoteSendPolicy(demoGate, Boolean(body.risk_acknowledged))

    if (!demoDecision.allowed) {
      return NextResponse.json<QualityGateBlockedResponse>(
        { error: demoDecision.reason ?? 'This quote cannot be sent yet.', quality_gate: demoGate },
        { status: 422 }
      )
    }

    let demoRiskSnapshot: RiskAcknowledgementSnapshot | null = null
    if (demoDecision.requiresAcknowledgement) {
      demoRiskSnapshot = buildRiskAcknowledgementSnapshot(quoteId, demoQuoteForGate, demoGate, sentAt)
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
      if (demoRiskSnapshot) {
        await recordProofEvent({
          jobId: demoJobId,
          builderId: sessionBuilderId,
          eventType: 'quote_sent_with_risk_acknowledged',
          description: `Builder acknowledged ${demoRiskSnapshot.reasons_accepted.length} flagged risk(s) ($${demoRiskSnapshot.exposure.exposed_value.toLocaleString('en-AU')} exposed, ${demoRiskSnapshot.exposure.exposed_pct}% of quote value) before sending`,
          metadata: {
            quote_id: quoteId,
            version: demoRiskSnapshot.version,
            exposure: demoRiskSnapshot.exposure,
            reasons_accepted: demoRiskSnapshot.reasons_accepted,
            affected_line_items: demoRiskSnapshot.affected_line_items,
          },
        })
      }
    }

    return NextResponse.json<ConfirmSendResponse>({ sent: true, sent_at: sentAt, communication_id: commId })
  }

  // ── Live path: Supabase ───────────────────────────────────────────────────

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // 1. Verify quote exists and belongs to this builder, load its quality
  // gate — one shared fetch+evaluate (lib/estimating/quote-quality-policy.ts),
  // never trusted from an earlier client-side read.
  const loaded = await loadQuoteQualityGate(supabase, quoteId, sessionBuilderId)
  if (!loaded) {
    return NextResponse.json({ error: 'Quote not found or unauthorized' }, { status: 404 })
  }
  const { quote: quoteForGate, gate: qualityGate } = loaded

  // 2. Forward-only state guard — only pending_review can be sent
  if (quoteForGate.status !== 'pending_review') {
    return NextResponse.json(
      { error: `Quote is already ${quoteForGate.status} — cannot send again` },
      { status: 422 }
    )
  }

  // 2b. The one send/export/share decision every external surface obeys.
  const decision = decideQuoteSendPolicy(qualityGate, Boolean(body.risk_acknowledged))
  if (!decision.allowed) {
    return NextResponse.json<QualityGateBlockedResponse>(
      { error: decision.reason ?? 'This quote cannot be sent yet.', quality_gate: qualityGate },
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

  // 4. Atomic status update — eq('status', 'pending_review') prevents double-sends.
  // When acknowledgement was required, the risk acceptance is written in the
  // SAME atomic update as the status change — the acknowledgement and the
  // send are one transaction, never a separate follow-up write that could
  // fail apart from it. Uses the same buildRiskAcknowledgementSnapshot the
  // GET route's shared policy module defines, so this record and the Proof
  // event below can never drift apart.
  const updatePayload: Record<string, unknown> = { status: 'sent', sent_at: sentAt }
  let riskSnapshot: RiskAcknowledgementSnapshot | null = null
  if (decision.requiresAcknowledgement) {
    riskSnapshot = buildRiskAcknowledgementSnapshot(quoteId, quoteForGate, qualityGate, sentAt)
    updatePayload.risk_acknowledged_at = sentAt
    updatePayload.risk_acknowledgement_snapshot = riskSnapshot
  }

  const { data: updated } = await supabase
    .from('quotes')
    .update(updatePayload)
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
      builder_id: sessionBuilderId,
      job_id: quoteForGate.jobId ?? null,
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
    jobId: quoteForGate.jobId,
    builderId: sessionBuilderId,
    eventType: 'quote_sent',
    description: `Quote sent to ${body.to} for approval — "${body.subject}"`,
    metadata: { quote_id: quoteId, to: body.to, subject: body.subject, communication_id: communicationId },
  })

  // WorkA Proof: a second, distinct event for the risk acceptance itself —
  // not folded into quote_sent's metadata, so it shows up on its own in the
  // Proof trail as exactly what it is: a conscious risk acceptance, not a
  // routine send. Metadata mirrors risk_acknowledgement_snapshot exactly
  // (reasons_accepted + affected_line_items, not just a narrower top_risks
  // read) so the immutable Proof record and the mutable quotes-row snapshot
  // can never describe two different things.
  if (riskSnapshot) {
    await recordProofEvent({
      jobId: quoteForGate.jobId,
      builderId: sessionBuilderId,
      eventType: 'quote_sent_with_risk_acknowledged',
      description: `Builder acknowledged ${riskSnapshot.reasons_accepted.length} flagged risk(s) ($${riskSnapshot.exposure.exposed_value.toLocaleString('en-AU')} exposed, ${riskSnapshot.exposure.exposed_pct}% of quote value) before sending`,
      metadata: {
        quote_id: quoteId,
        version: riskSnapshot.version,
        exposure: riskSnapshot.exposure,
        reasons_accepted: riskSnapshot.reasons_accepted,
        affected_line_items: riskSnapshot.affected_line_items,
      },
    })
  }

  return NextResponse.json<ConfirmSendResponse>({
    sent: true,
    sent_at: sentAt,
    communication_id: communicationId,
  })
}
