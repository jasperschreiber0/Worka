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
    const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!sbUrl || !sbKey) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }
    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })

    const [{ data: quoteRow }, { data: lineItems }] = await Promise.all([
      sb.from('quotes')
        .select('id, job_id, status, total_cost, margin_pct, confidence_score, version, created_at')
        .eq('id', quoteId).eq('builder_id', body.builder_id).single(),
      sb.from('quote_line_items')
        .select('id, trade_category_id, description, quantity, unit, rate, total, is_assumption, assumption_status')
        .eq('quote_id', quoteId),
    ])

    if (!quoteRow) return NextResponse.json({ error: 'Quote not found' }, { status: 404 })

    type QuoteRow = { id: string; job_id: string; status: string; total_cost: number; margin_pct: number; confidence_score: number; version: number; created_at: string }
    type LineItemRow = { id: string; trade_category_id: number; description: string; quantity: number | null; unit: string | null; rate: number | null; total: number | null; is_assumption: boolean; assumption_status: string | null }
    type JobRow = { address: string; client_id: string | null }
    type ClientRow = { name: string; email: string | null }
    type BuilderRow = { business_name: string | null; contact_name: string | null }

    const tq = quoteRow as QuoteRow
    const { data: jobRow } = await sb.from('jobs').select('address, client_id').eq('id', tq.job_id).single()
    const tj = jobRow as JobRow | null

    let resolvedClientName = body.client_name ?? 'there'
    let resolvedClientEmail = body.client_email ?? ''
    if (tj?.client_id) {
      const { data: clientRow } = await sb.from('clients').select('name, email').eq('id', tj.client_id).single()
      const tc = clientRow as ClientRow | null
      if (tc) {
        resolvedClientName = body.client_name ?? tc.name ?? 'there'
        resolvedClientEmail = body.client_email ?? tc.email ?? ''
      }
    }

    const { data: builderRow } = await sb.from('builders').select('business_name, contact_name').eq('id', body.builder_id).single()
    const tb = builderRow as BuilderRow | null
    const resolvedBuilderName = tb?.contact_name ?? 'Dave Nguyen'
    const resolvedBusinessName = tb?.business_name ?? 'Nguyen Building Co.'

    quote = {
      id: tq.id, job_id: tq.job_id, job_address: tj?.address ?? 'the project',
      builder_id: body.builder_id,
      status: tq.status as DemoQuote['status'], total_cost: tq.total_cost,
      margin_pct: tq.margin_pct, confidence_score: tq.confidence_score,
      version: tq.version, created_at: tq.created_at,
    }
    items = ((lineItems ?? []) as LineItemRow[]).map((li) => ({
      id: li.id, quote_id: quoteId, trade_category_id: li.trade_category_id,
      trade_category_name: '', description: li.description,
      quantity: li.quantity, unit: li.unit, rate: li.rate, total: li.total,
      dimensions_string: null,
      is_assumption: li.is_assumption,
      assumption_status: li.assumption_status as DemoQuoteLineItem['assumption_status'],
      confidence: 100,
      pricing_type: 'measured' as const,
      source_ref: null,
      margin_pct: 0.15,
      labour_cost: null,
      material_cost: null,
      subcontract_cost: null,
      plant_cost: null,
    }))

    const activeItemsDb = items.filter((i) => i.assumption_status !== 'excluded' && i.total !== null)
    const emailBodyDb = buildEmailBody({
      clientName: resolvedClientName, address: quote.job_address,
      totalCost: quote.total_cost, lineCount: activeItemsDb.length,
      builderName: resolvedBuilderName, businessName: resolvedBusinessName,
      customMessage: body.message,
    })
    const draftDb: EmailDraft = {
      to: resolvedClientEmail || 'client@example.com',
      subject: `Quote for ${quote.job_address} — ${resolvedBusinessName}`,
      body: emailBodyDb,
      quote_summary: { total_cost: quote.total_cost, margin_pct: quote.margin_pct, line_count: activeItemsDb.length, address: quote.job_address },
    }
    return NextResponse.json({ draft: draftDb, requires_confirmation: true } as SendResponse)
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
