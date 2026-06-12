import { NextRequest, NextResponse } from 'next/server'
import { DEMO_QUOTE, DEMO_LINE_ITEMS } from '@/lib/quote-demo'
import type { DemoQuote, DemoQuoteLineItem } from '@/lib/quote-demo'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'

// ─── Request body ─────────────────────────────────────────────────────────────

interface SendRequestBody {
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
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { quoteId } = params

  let body: SendRequestBody
  try {
    body = await request.json() as SendRequestBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // ── Fetch quote data ──────────────────────────────────────────────────────

  let quote: DemoQuote
  let items: DemoQuoteLineItem[]
  let builderName = 'Dave Nguyen'
  let businessName = 'Nguyen Building Co.'
  let clientNameFromDb: string | null = null
  let clientEmailFromDb: string | null = null

  if (isDemoMode()) {
    const data = getDemoQuoteData()
    quote = data.quote
    items = data.items
  } else {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Quote + job, scoped to the authenticated builder
    const { data: quoteRow, error: quoteErr } = await supabase
      .from('quotes')
      .select('id, job_id, builder_id, status, total_cost, margin_pct, confidence_score, version, created_at, jobs ( address, client_id )')
      .eq('id', quoteId)
      .eq('builder_id', builderId)
      .single()

    if (quoteErr || !quoteRow) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }

    const { data: lineRows, error: lineErr } = await supabase
      .from('quote_line_items')
      .select('id, quote_id, trade_category_id, description, quantity, unit, rate, total, confidence, dimensions_string, is_assumption, assumption_status')
      .eq('quote_id', quoteId)

    if (lineErr) {
      return NextResponse.json({ error: 'Failed to load quote line items' }, { status: 500 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobRow = (quoteRow as any).jobs as { address: string; client_id: string | null } | null

    quote = {
      id: quoteRow.id,
      job_id: quoteRow.job_id,
      job_address: jobRow?.address ?? 'Unknown address',
      builder_id: quoteRow.builder_id,
      status: quoteRow.status as DemoQuote['status'],
      total_cost: quoteRow.total_cost ?? 0,
      margin_pct: quoteRow.margin_pct ?? 0,
      confidence_score: quoteRow.confidence_score ?? 0,
      version: quoteRow.version ?? 1,
      created_at: quoteRow.created_at,
    }

    items = (lineRows ?? []).map((row) => ({
      id: row.id,
      quote_id: row.quote_id,
      trade_category_id: row.trade_category_id,
      trade_category_name: '',
      description: row.description,
      quantity: row.quantity ?? null,
      unit: row.unit ?? null,
      rate: row.rate ?? null,
      total: row.total ?? null,
      confidence: row.confidence ?? 0,
      dimensions_string: row.dimensions_string ?? null,
      is_assumption: row.is_assumption ?? false,
      assumption_status: (row.assumption_status ?? null) as DemoQuoteLineItem['assumption_status'],
    }))

    // Builder identity for the email signature
    const { data: builderRow } = await supabase
      .from('builders')
      .select('name, business_name')
      .eq('id', builderId)
      .single()
    if (builderRow) {
      builderName = builderRow.name
      businessName = builderRow.business_name ?? builderRow.name
    }

    // Client contact details, when the job has a linked client
    if (jobRow?.client_id) {
      const { data: clientRow } = await supabase
        .from('clients')
        .select('name, email')
        .eq('id', jobRow.client_id)
        .eq('builder_id', builderId)
        .single()
      if (clientRow) {
        clientNameFromDb = clientRow.name
        clientEmailFromDb = clientRow.email
      }
    }
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

  // ── Block sending while any assumption is unresolved ──────────────────────

  let unresolvedCount: number
  if (isDemoMode()) {
    // Demo resolutions live in the in-memory state map, not the static items
    const { DEMO_ASSUMPTIONS, demoResolutionState } = await import('@/lib/assumptions-demo')
    unresolvedCount = DEMO_ASSUMPTIONS.filter((a) => {
      const resolved = demoResolutionState.get(a.id)?.resolution_type ?? a.resolution_type
      return resolved === 'unresolved'
    }).length
  } else {
    unresolvedCount = items.filter(
      (i) => i.is_assumption && i.assumption_status === 'unresolved'
    ).length
  }
  if (unresolvedCount > 0) {
    return NextResponse.json(
      { error: `Quote has ${unresolvedCount} unresolved assumption${unresolvedCount !== 1 ? 's' : ''} — resolve them before sending.` },
      { status: 422 }
    )
  }

  // ── Count active (non-excluded) line items ─────────────────────────────────

  const activeItems = items.filter((i) => i.assumption_status !== 'excluded' && i.total !== null)
  const lineCount = activeItems.length

  // ── Generate email draft — DO NOT send anything yet ───────────────────────

  const clientName = body.client_name || clientNameFromDb || 'there'
  const clientEmail = body.client_email || clientEmailFromDb || (isDemoMode() ? 'client@example.com' : null)
  if (!clientEmail) {
    return NextResponse.json(
      { error: 'No client email on file for this job — provide client_email to draft the send.' },
      { status: 422 }
    )
  }
  const address = quote.job_address

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
