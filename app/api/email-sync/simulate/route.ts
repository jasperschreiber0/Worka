import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import type { ParseResponse } from '../parse/route'
import {
  matchJobToEmail,
  classifyIntentByKeywords,
  buildSuggestedAction,
  logCommunication,
  DEMO_MATCHABLE_JOBS,
} from '../parse/route'
import Anthropic from '@anthropic-ai/sdk'
import type { EmailIntent } from '../parse/route'

// ─── Demo email scenarios ─────────────────────────────────────────────────────

type SimulateScenario = 'quote_acceptance' | 'invoice_query' | 'variation_approval' | 'new_request'

interface SimulateRequestBody {
  builder_id: string
  scenario: SimulateScenario
}

interface DemoEmailData {
  from: string
  subject: string
  body: string
  received_at: string
  message_id: string
}

const DEMO_EMAILS: Record<SimulateScenario, DemoEmailData> = {
  quote_acceptance: {
    from: 'tom@carusoproperty.com.au',
    subject: 'Re: Quote for 8 Burnside Rd, Toorak',
    body: 'Hi Dave, thanks for the quote. Looks good to us. Happy to proceed — what are the next steps?',
    received_at: new Date().toISOString(),
    message_id: 'demo-msg-001',
  },
  invoice_query: {
    from: 'henderson@email.com',
    subject: 'Re: Invoice — 14 Merri St, Fitzroy',
    body: 'Hi Dave, just checking on the invoice — can we pay via bank transfer? What are your details?',
    received_at: new Date().toISOString(),
    message_id: 'demo-msg-002',
  },
  variation_approval: {
    from: 'henderson@email.com',
    subject: 'Re: Variation request — kitchen benchtop',
    body: 'Yes, go ahead with the Caesarstone upgrade. Approved.',
    received_at: new Date().toISOString(),
    message_id: 'demo-msg-003',
  },
  new_request: {
    from: 'sarah.jones@gmail.com',
    subject: 'Quote for rear extension — 22 Park St, Collingwood',
    body: 'Hi, I got your number from a friend. Looking for a quote on a rear extension at 22 Park St Collingwood. About 40sqm. Can you help?',
    received_at: new Date().toISOString(),
    message_id: 'demo-msg-004',
  },
}

// ─── AI intent classification ─────────────────────────────────────────────────

async function classifyIntentWithAI(
  email: DemoEmailData,
  anthropic: Anthropic
): Promise<{ intent: EmailIntent; confidence: number }> {
  const prompt = `You are an email classifier for WorkA, an AI operations manager for Australian residential builders.

Classify this inbound email into exactly one of these intents:
- variation_approval: client approving a variation/change order
- variation_rejection: client rejecting a variation
- quote_acceptance: client accepting the quote
- quote_question: client asking about the quote
- invoice_payment: client confirming payment
- invoice_dispute: client disputing or querying an invoice
- delivery_eta: supplier/subbie with delivery info
- new_quote_request: new potential client requesting a quote
- general_reply: general reply, no specific action needed
- unrelated: not related to any active job

Email:
From: ${email.from}
Subject: ${email.subject}
Body: ${email.body}

Respond ONLY with valid JSON:
{
  "intent": "<intent_value>",
  "confidence": <number 0-100>
}`

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 128,
    messages: [{ role: 'user', content: prompt }],
  })

  const content = response.content[0]
  if (content.type !== 'text') {
    return classifyIntentByKeywords(email)
  }

  try {
    const cleaned = content.text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    const parsed = JSON.parse(cleaned) as { intent: EmailIntent; confidence: number }
    return parsed
  } catch {
    return classifyIntentByKeywords(email)
  }
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest
): Promise<NextResponse<ParseResponse | { error: string }>> {
  try {
    const body = (await request.json()) as SimulateRequestBody
    const builder_id = await getAuthenticatedBuilderId()
    if (!builder_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { scenario } = body

    const validScenarios: SimulateScenario[] = [
      'quote_acceptance',
      'invoice_query',
      'variation_approval',
      'new_request',
    ]

    if (!scenario || !validScenarios.includes(scenario)) {
      return NextResponse.json(
        {
          error: `Invalid scenario. Use one of: ${validScenarios.join(', ')}`,
        },
        { status: 400 }
      )
    }

    const email = DEMO_EMAILS[scenario]

    // 1. Job matching
    const matchedJob = matchJobToEmail(email, DEMO_MATCHABLE_JOBS)

    // 2. Intent classification — use AI if available, fallback to keyword
    const apiKey = process.env.ANTHROPIC_API_KEY
    let classifyResult: { intent: EmailIntent; confidence: number }

    if (apiKey) {
      const anthropic = new Anthropic({ apiKey })
      classifyResult = await classifyIntentWithAI(email, anthropic)
    } else {
      classifyResult = classifyIntentByKeywords(email)
    }

    const { intent, confidence } = classifyResult

    // 3. Unrelated and no match → no logging
    if (intent === 'unrelated' && !matchedJob) {
      return NextResponse.json({
        matched: false,
        job_id: null,
        job_address: null,
        intent,
        confidence,
        communication_id: null,
        suggested_action: null,
        auto_logged: false,
      })
    }

    // 4. Log to communication history
    const passiveIntents: EmailIntent[] = ['general_reply', 'unrelated']
    const isPassive = passiveIntents.includes(intent)

    let communicationId: string | null = null
    let autoLogged = false

    if (matchedJob) {
      communicationId = await logCommunication(builder_id, matchedJob.id, email)
      autoLogged = isPassive
    } else if (intent === 'new_quote_request') {
      communicationId = await logCommunication(builder_id, null, email)
      autoLogged = false
    }

    // 5. Build suggested action
    const suggestedAction = buildSuggestedAction(intent, matchedJob ?? null, email)

    return NextResponse.json({
      matched: matchedJob !== null || intent === 'new_quote_request',
      job_id: matchedJob?.id ?? null,
      job_address: matchedJob?.address ?? null,
      intent,
      confidence,
      communication_id: communicationId,
      suggested_action: suggestedAction,
      auto_logged: autoLogged,
    })
  } catch (err) {
    console.error('[/api/email-sync/simulate] Error:', err)
    return NextResponse.json({ error: 'Failed to simulate email' }, { status: 500 })
  }
}
