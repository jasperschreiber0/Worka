import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getDemoJobSnapshot } from '@/lib/job-snapshot-demo'
import { addCommEntry } from '@/lib/comms-demo'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

// ─── Types ────────────────────────────────────────────────────────────────────

export type EmailIntent =
  | 'variation_approval'
  | 'variation_rejection'
  | 'quote_acceptance'
  | 'quote_question'
  | 'invoice_payment'
  | 'invoice_dispute'
  | 'delivery_eta'
  | 'new_quote_request'
  | 'general_reply'
  | 'unrelated'

interface InboundEmail {
  from: string
  subject: string
  body: string
  received_at: string
  message_id: string
}

interface ParseRequestBody {
  builder_id: string
  email: InboundEmail
}

interface SuggestedActionDraft {
  subject: string
  body: string
}

interface SuggestedActionEvent {
  type: string
  [key: string]: unknown
}

interface SuggestedAction {
  type: 'draft_reply' | 'update_status' | 'create_job' | 'flag_in_brief'
  description: string
  draft?: SuggestedActionDraft
  event?: SuggestedActionEvent
}

interface ParseResponse {
  matched: boolean
  job_id: string | null
  job_address: string | null
  intent: EmailIntent
  confidence: number
  communication_id: string | null
  suggested_action: SuggestedAction | null
  auto_logged: boolean
}

// ─── Demo jobs for matching ───────────────────────────────────────────────────

interface MatchableJob {
  id: string
  address: string
  client_name: string | null
  client_email: string | null
  normalised_address: string
  address_tokens: string[]
}

const DEMO_MATCHABLE_JOBS: MatchableJob[] = [
  {
    id: '00000000-0000-0000-0000-000000000010',
    address: '14 Merri St, Fitzroy VIC 3065',
    client_name: 'Hendersons',
    client_email: 'henderson@example.com',
    normalised_address: '14 merri st fitzroy',
    address_tokens: ['14', 'merri', 'fitzroy'],
  },
  {
    id: '00000000-0000-0000-0000-000000000011',
    address: '8 Burnside Rd, Toorak VIC 3142',
    client_name: 'Tom Caruso',
    client_email: 'tom.caruso@example.com',
    normalised_address: '8 burnside rd toorak',
    address_tokens: ['8', 'burnside', 'toorak'],
  },
  {
    id: '00000000-0000-0000-0000-000000000020',
    address: '8 Burnside Rd, Toorak VIC 3142',
    client_name: 'Tom Caruso',
    client_email: 'tom@carusoproperty.com.au',
    normalised_address: '8 burnside rd toorak',
    address_tokens: ['8', 'burnside', 'toorak'],
  },
  {
    id: '00000000-0000-0000-0000-000000000012',
    address: '52 Bendigo St, Brunswick VIC 3056',
    client_name: null,
    client_email: null,
    normalised_address: '52 bendigo st brunswick',
    address_tokens: ['52', 'bendigo', 'brunswick'],
  },
]

// ─── Fuzzy address normalisation ──────────────────────────────────────────────

function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,\-#]/g, ' ')
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bplace\b/g, 'pl')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchJobToEmail(email: InboundEmail, jobs: MatchableJob[]): MatchableJob | null {
  const fromNorm = normaliseText(email.from)
  const subjectNorm = normaliseText(email.subject)
  const bodyNorm = normaliseText(email.body)
  const combined = `${subjectNorm} ${bodyNorm}`

  for (const job of jobs) {
    // 1. Exact client email match
    if (job.client_email) {
      const clientEmailNorm = job.client_email.toLowerCase()
      if (fromNorm.includes(clientEmailNorm) || clientEmailNorm === email.from.toLowerCase()) {
        return job
      }
    }

    // 2. Client name match in combined text (if client name exists)
    if (job.client_name) {
      const clientNameNorm = normaliseText(job.client_name)
      if (combined.includes(clientNameNorm)) {
        return job
      }
    }

    // 3. Address token matching — require street number + street name
    const addressTokens = job.address_tokens
    const streetNumber = addressTokens[0]
    const streetName = addressTokens[1]
    if (
      streetNumber &&
      streetName &&
      combined.includes(streetNumber) &&
      combined.includes(streetName)
    ) {
      return job
    }
  }

  return null
}

// ─── Keyword-based intent fallback ───────────────────────────────────────────

function classifyIntentByKeywords(email: InboundEmail): { intent: EmailIntent; confidence: number } {
  const combined = `${email.subject} ${email.body}`.toLowerCase()

  if (
    combined.includes('approved') ||
    combined.includes('go ahead') ||
    combined.includes('approve') ||
    (combined.includes('variation') && combined.includes('yes'))
  ) {
    return { intent: 'variation_approval', confidence: 72 }
  }

  if (
    combined.includes('reject') ||
    combined.includes('not approved') ||
    combined.includes("don't approve") ||
    (combined.includes('variation') && combined.includes('no'))
  ) {
    return { intent: 'variation_rejection', confidence: 72 }
  }

  if (
    combined.includes('happy to proceed') ||
    combined.includes('accept the quote') ||
    combined.includes('accepted') ||
    (combined.includes('quote') && (combined.includes('proceed') || combined.includes('yes')))
  ) {
    return { intent: 'quote_acceptance', confidence: 75 }
  }

  if (
    (combined.includes('quote') && combined.includes('question')) ||
    (combined.includes('quote') && combined.includes('query')) ||
    combined.includes('what does') ||
    combined.includes('can you explain')
  ) {
    return { intent: 'quote_question', confidence: 65 }
  }

  if (
    combined.includes('paid') ||
    combined.includes('payment made') ||
    combined.includes('transferred') ||
    (combined.includes('invoice') && combined.includes('paid'))
  ) {
    return { intent: 'invoice_payment', confidence: 72 }
  }

  if (
    combined.includes('dispute') ||
    combined.includes('incorrect') ||
    (combined.includes('invoice') &&
      (combined.includes('query') ||
        combined.includes('question') ||
        combined.includes('checking') ||
        combined.includes('bank transfer')))
  ) {
    return { intent: 'invoice_dispute', confidence: 65 }
  }

  if (
    combined.includes('delivery') ||
    combined.includes('eta') ||
    combined.includes('arrives') ||
    combined.includes('shipment')
  ) {
    return { intent: 'delivery_eta', confidence: 68 }
  }

  if (
    (combined.includes('quote') || combined.includes('quotation')) &&
    (combined.includes('looking for') ||
      combined.includes('can you help') ||
      combined.includes('interested in') ||
      combined.includes('like a quote'))
  ) {
    return { intent: 'new_quote_request', confidence: 75 }
  }

  return { intent: 'general_reply', confidence: 50 }
}

// ─── AI intent classification ─────────────────────────────────────────────────

async function classifyIntentWithAI(
  email: InboundEmail,
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

// ─── Suggested action builder ─────────────────────────────────────────────────

function buildSuggestedAction(
  intent: EmailIntent,
  job: MatchableJob | null,
  email: InboundEmail
): SuggestedAction | null {
  const snapshot = job ? getDemoJobSnapshot(job.id) : null
  const clientName = snapshot?.job.client_name ?? job?.client_name ?? 'the client'
  const jobAddress = job?.address ?? 'the job'

  switch (intent) {
    case 'variation_approval':
      return {
        type: 'update_status',
        description: 'Mark the pending variation as approved and notify the client.',
        event: { type: 'update_variation_status', job_id: job?.id ?? null, status: 'approved' },
      }

    case 'variation_rejection':
      return {
        type: 'update_status',
        description: 'Mark the pending variation as rejected.',
        event: { type: 'update_variation_status', job_id: job?.id ?? null, status: 'rejected' },
      }

    case 'quote_acceptance':
      return {
        type: 'draft_reply',
        description: 'Reply to confirm next steps and activate the job.',
        draft: {
          subject: `Re: ${email.subject}`,
          body: `Hi ${clientName},\n\nThanks for confirming — great to hear you're happy to proceed.\n\nI'll be in touch shortly with the next steps to get the work underway at ${jobAddress}.\n\nDave Nguyen\nNguyen Constructions`,
        },
      }

    case 'quote_question':
      return {
        type: 'draft_reply',
        description: 'Draft a reply addressing their quote query.',
        draft: {
          subject: `Re: ${email.subject}`,
          body: `Hi ${clientName},\n\nThanks for getting back to me. Happy to walk through any questions you have about the quote for ${jobAddress}.\n\nWould you prefer a quick call or shall I answer via email?\n\nDave Nguyen\nNguyen Constructions`,
        },
      }

    case 'invoice_payment':
      return {
        type: 'update_status',
        description: 'Mark the invoice as paid.',
        event: { type: 'update_invoice_status', job_id: job?.id ?? null, status: 'paid' },
      }

    case 'invoice_dispute':
      return {
        type: 'draft_reply',
        description: 'Draft a reply to address their invoice query.',
        draft: {
          subject: `Re: ${email.subject}`,
          body: `Hi ${clientName},\n\nThanks for getting in touch about the invoice for ${jobAddress}.\n\nI'm happy to help — please let me know your preferred payment method and I'll send through the bank details.\n\nDave Nguyen\nNguyen Constructions`,
        },
      }

    case 'delivery_eta':
      return {
        type: 'flag_in_brief',
        description: 'Delivery ETA logged — check if it affects the site timeline.',
        event: { type: 'flag_delivery_eta', job_id: job?.id ?? null },
      }

    case 'new_quote_request':
      return {
        type: 'create_job',
        description: 'Create a new job record for this enquiry and draft a reply.',
        draft: {
          subject: `Re: ${email.subject}`,
          body: `Hi,\n\nThanks for getting in touch. I'd be happy to provide a quote for your project.\n\nCould you let me know the best time for me to visit the site and take a look?\n\nDave Nguyen\nNguyen Constructions`,
        },
      }

    case 'general_reply':
      return null

    case 'unrelated':
      return null

    default:
      return null
  }
}

// ─── Log to communication history ────────────────────────────────────────────

async function logCommunication(
  builderId: string,
  jobId: string | null,
  email: InboundEmail
): Promise<string> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (supabaseUrl && serviceRoleKey) {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data, error } = await supabase
      .from('communication_history')
      .insert({
        builder_id: builderId,
        job_id: jobId,
        direction: 'inbound',
        channel: 'email',
        subject: email.subject,
        body: email.body,
        from_address: email.from,
        to_address: null,
        linked_variation_id: null,
        linked_invoice_id: null,
      })
      .select('id')
      .single()

    if (!error && data) {
      return (data as { id: string }).id
    }
  }

  // Demo mode: log to in-memory store
  const entry = addCommEntry({
    job_id: jobId,
    builder_id: builderId,
    direction: 'inbound',
    channel: 'email',
    subject: email.subject,
    body: email.body,
    from_address: email.from,
    to_address: null,
    linked_variation_id: null,
    linked_invoice_id: null,
  })

  return entry.id
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest
): Promise<NextResponse<ParseResponse | { error: string }>> {
  try {
    const body = (await request.json()) as ParseRequestBody
    const { builder_id, email } = body

    if (!builder_id || !email) {
      return NextResponse.json({ error: 'builder_id and email are required' }, { status: 400 })
    }

    // 1. Job matching
    const matchedJob = matchJobToEmail(email, DEMO_MATCHABLE_JOBS)

    // 2. Intent classification
    const apiKey = process.env.ANTHROPIC_API_KEY
    let classifyResult: { intent: EmailIntent; confidence: number }

    if (apiKey) {
      const anthropic = new Anthropic({ apiKey })
      classifyResult = await classifyIntentWithAI(email, anthropic)
    } else {
      classifyResult = classifyIntentByKeywords(email)
    }

    const { intent, confidence } = classifyResult

    // 3. Unrelated → no logging, no action
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

    // 4. Passive intents (general reply with job match) → auto-log, no approval
    const passiveIntents: EmailIntent[] = ['general_reply', 'unrelated']
    const isPassive = passiveIntents.includes(intent)

    let communicationId: string | null = null
    let autoLogged = false

    if (matchedJob) {
      // Log all matched emails — passive ones silently, actionable ones still logged
      communicationId = await logCommunication(builder_id, matchedJob.id, email)
      autoLogged = isPassive
    } else if (intent === 'new_quote_request') {
      // Log new quote requests without a job match
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
    console.error('[/api/email-sync/parse] Error:', err)
    return NextResponse.json({ error: 'Failed to parse email' }, { status: 500 })
  }
}

// Export for use in simulate endpoint
export { matchJobToEmail, classifyIntentByKeywords, buildSuggestedAction, logCommunication, DEMO_MATCHABLE_JOBS }
export type { MatchableJob, ParseResponse }
