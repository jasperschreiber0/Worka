import { NextRequest, NextResponse } from 'next/server'
import { DEMO_QUOTE, DEMO_LINE_ITEMS } from '@/lib/quote-demo'
import type { DemoQuote, DemoQuoteLineItem } from '@/lib/quote-demo'

// ─── Request body ─────────────────────────────────────────────────────────────

interface SendRequestBody {
  builder_id: string
  client_email?: string
  client_name?: string
  message?: string
}

// ─── Response shapes ──────────────────────────────────────────────────────────

interface QuoteSummaryForDraft {
  total_cost: number
  margin_pct: number
  line_count: number
  address: string
}

interface EmailDraft {
  to: string
  subject: string
  body: string
  quote_summary: QuoteSummaryForDraft
}

interface SendResponse {
  draft: EmailDraft
  requires_confirmation: true
}

// ─── Build email body ─────────────────────────────────────────────────────────

function buildEmailBody(params: {
  clientName: string
  address: string
  totalCost: number
  lineCount: number
  builderName: string
  businessName: string
  customMessage?: string
}): string {
  const { clientName, address, totalCost, lineCount, builderName, businessName, customMessage } = params

  const formattedTotal = `$${totalCost.toLocaleString('en-AU')}`

  const lines: string[] = [
    `Hi ${clientName},`,
    '',
    `Please find attached your quote for ${address}.`,
    '',
    'Summary:',
    `• Total: ${formattedTotal}`,
    `• ${lineCount} trade items included`,
    '• Quote valid for 30 days',
  ]

  if (customMessage?.trim()) {
    lines.push('')
    lines.push(customMessage.trim())
  }

  lines.push('')
  lines.push('To accept this quote, simply reply to this email or call me directly.')
  lines.push('')
  lines.push(builderName)
  lines.push(businessName)

  return lines.join('\n')
}

// ─── GET quote data (demo or Supabase) ───────────────────────────────────────

function getDemoQuoteData(): { quote: DemoQuote; items: DemoQuoteLineItem[] } {
  return {
    quote: DEMO_QUOTE,
    items: DEMO_LINE_ITEMS,
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { quoteId: string } }
): Promise<NextResponse> {
  const { quoteId } = params

  let body: SendRequestBody
  try {
    body = await request.json() as SendRequestBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.builder_id) {
    return NextResponse.json({ error: 'builder_id is required' }, { status: 400 })
  }

  // ── Fetch quote data ──────────────────────────────────────────────────────

  let quote: DemoQuote
  let items: DemoQuoteLineItem[]

  if (quoteId === 'demo-quote-id') {
    const data = getDemoQuoteData()
    quote = data.quote
    items = data.items
  } else {
    // Real Supabase path — not implemented in this session
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
  }

  // ── Verify quote is in pending_review state ───────────────────────────────

  if (quote.status !== 'pending_review') {
    return NextResponse.json(
      {
        error: `Quote cannot be sent — current status is '${quote.status}'. Only quotes in 'pending_review' can be sent.`,
      },
      { status: 422 }
    )
  }

  // ── Count active (non-excluded) line items ─────────────────────────────────

  const activeItems = items.filter((i) => i.assumption_status !== 'excluded' && i.total !== null)
  const lineCount = activeItems.length

  // ── Generate email draft — DO NOT send anything yet ───────────────────────

  const clientName = body.client_name || 'there'
  const clientEmail = body.client_email || 'client@example.com'
  const address = quote.job_address
  const builderName = 'Dave Nguyen'
  const businessName = 'Nguyen Building Co.'

  const emailBody = buildEmailBody({
    clientName,
    address,
    totalCost: quote.total_cost,
    lineCount,
    builderName,
    businessName,
    customMessage: body.message,
  })

  const draft: EmailDraft = {
    to: clientEmail,
    subject: `Quote for ${address} — ${businessName}`,
    body: emailBody,
    quote_summary: {
      total_cost: quote.total_cost,
      margin_pct: quote.margin_pct,
      line_count: lineCount,
      address,
    },
  }

  const response: SendResponse = {
    draft,
    requires_confirmation: true,
  }

  return NextResponse.json(response, { status: 200 })
}
