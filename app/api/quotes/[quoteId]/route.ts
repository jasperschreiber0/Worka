import { NextRequest, NextResponse } from 'next/server'
import { DEMO_QUOTE, DEMO_LINE_ITEMS } from '@/lib/quote-demo'
import type { DemoQuote, DemoQuoteLineItem } from '@/lib/quote-demo'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'

// ─── Response shapes ──────────────────────────────────────────────────────────

interface LineItemsByCategory {
  category_id: number
  category_name: string
  items: DemoQuoteLineItem[]
  category_total: number
  has_assumptions: boolean
  min_confidence: number
}

interface QuoteSummary {
  total_cost: number
  margin_pct: number
  confidence_score: number
  unresolved_count: number
  assumption_count: number
  can_send: boolean
}

interface QuoteResponse {
  quote: DemoQuote
  line_items_by_category: LineItemsByCategory[]
  summary: QuoteSummary
}

// ─── Helper: group line items by trade category ───────────────────────────────

function groupByCategory(items: DemoQuoteLineItem[]): LineItemsByCategory[] {
  const map = new Map<number, LineItemsByCategory>()

  for (const item of items) {
    if (!map.has(item.trade_category_id)) {
      map.set(item.trade_category_id, {
        category_id: item.trade_category_id,
        category_name: item.trade_category_name,
        items: [],
        category_total: 0,
        has_assumptions: false,
        min_confidence: 100,
      })
    }

    const group = map.get(item.trade_category_id)!
    group.items.push(item)

    // Excluded items don't count toward the category total
    if (item.assumption_status !== 'excluded') {
      group.category_total += item.total ?? 0
    }

    if (item.is_assumption) {
      group.has_assumptions = true
    }

    if (item.confidence < group.min_confidence) {
      group.min_confidence = item.confidence
    }
  }

  // Sort categories by trade_category_id (sort_order 1–13 is locked)
  return Array.from(map.values()).sort((a, b) => a.category_id - b.category_id)
}

// ─── Helper: compute summary ──────────────────────────────────────────────────

function computeSummary(quote: DemoQuote, items: DemoQuoteLineItem[]): QuoteSummary {
  const unresolved_count = items.filter(
    (i) => i.is_assumption && i.assumption_status === 'unresolved'
  ).length

  const assumption_count = items.filter((i) => i.is_assumption).length

  return {
    total_cost: quote.total_cost,
    margin_pct: quote.margin_pct,
    confidence_score: quote.confidence_score,
    unresolved_count,
    assumption_count,
    can_send: unresolved_count === 0,
  }
}

// ─── GET /api/quotes/[quoteId] ────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: { quoteId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { quoteId } = params

  // ── Demo mode ──────────────────────────────────────────────────────────────
  if (isDemoMode()) {
    const line_items_by_category = groupByCategory(DEMO_LINE_ITEMS)
    const summary = computeSummary(DEMO_QUOTE, DEMO_LINE_ITEMS)

    const response: QuoteResponse = {
      quote: DEMO_QUOTE,
      line_items_by_category,
      summary,
    }

    return NextResponse.json(response)
  }

  // ── Real mode: Supabase ───────────────────────────────────────────────────
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Fetch the quote with job address — scoped to the authenticated builder
    const { data: quoteRow, error: quoteErr } = await supabase
      .from('quotes')
      .select(`
        id,
        job_id,
        builder_id,
        status,
        total_cost,
        margin_pct,
        confidence_score,
        version,
        created_at,
        jobs (
          address
        )
      `)
      .eq('id', quoteId)
      .eq('builder_id', builderId)
      .single()

    if (quoteErr || !quoteRow) {
      return NextResponse.json(
        { error: quoteErr?.message ?? 'Quote not found' },
        { status: 404 }
      )
    }

    // Fetch line items with trade categories
    const { data: lineRows, error: lineErr } = await supabase
      .from('quote_line_items')
      .select(`
        id,
        quote_id,
        trade_category_id,
        description,
        quantity,
        unit,
        rate,
        total,
        confidence,
        dimensions_string,
        is_assumption,
        assumption_status,
        trade_categories (
          id,
          name
        )
      `)
      .eq('quote_id', quoteId)
      .order('trade_category_id', { ascending: true })

    if (lineErr) {
      return NextResponse.json({ error: lineErr.message }, { status: 500 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobRow = (quoteRow as any).jobs as { address: string } | null

    const quote: DemoQuote = {
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

    const items: DemoQuoteLineItem[] = (lineRows ?? []).map((row) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tc = (row as any).trade_categories as { id: number; name: string } | null
      return {
        id: row.id,
        quote_id: row.quote_id,
        trade_category_id: row.trade_category_id,
        trade_category_name: tc?.name ?? 'Unknown',
        description: row.description,
        quantity: row.quantity ?? null,
        unit: row.unit ?? null,
        rate: row.rate ?? null,
        total: row.total ?? null,
        confidence: row.confidence ?? 0,
        dimensions_string: row.dimensions_string ?? null,
        is_assumption: row.is_assumption ?? false,
        assumption_status: (row.assumption_status ?? null) as DemoQuoteLineItem['assumption_status'],
      }
    })

    const line_items_by_category = groupByCategory(items)
    const summary = computeSummary(quote, items)

    const response: QuoteResponse = {
      quote,
      line_items_by_category,
      summary,
    }

    return NextResponse.json(response)
  } catch (err) {
    console.error('Quote GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
