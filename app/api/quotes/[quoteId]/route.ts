import { NextRequest, NextResponse } from 'next/server'
import { DEMO_QUOTE, DEMO_LINE_ITEMS } from '@/lib/quote-demo'
import type { DemoQuote, DemoQuoteLineItem } from '@/lib/quote-demo'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { calculateClientPrice, ensureQuotePriced, PRICE_BASIS_LABEL, CLIENT_PRICE_DISCLAIMER } from '@/lib/pricing'
import { deriveQuoteReadiness, isSilentlyUnpriced, type QuoteReadiness } from '@/lib/estimating/readiness'
import type { QAReport } from '@/lib/types/database.types'

// ─── Response shapes ──────────────────────────────────────────────────────────

interface LineItemsByCategory {
  category_id: number
  category_name: string
  items: DemoQuoteLineItem[]
  category_total: number
  has_assumptions: boolean
  min_confidence: number
}

/**
 * WorkA proceeded past a blocking clarifying question using this disclosed
 * default instead of stopping the pipeline — non-blocking estimation, see
 * buildConservativeAssumption (pipeline-logic.ts). Distinct from Gate 1-3
 * assumptions (assumptions.gate IS NOT NULL, tied to one line item) — these
 * are project/trade-level, never tied to a single line_item_id.
 */
interface CriticalAssumption {
  id: string
  question: string
  assumed_value: string
  reason: string
  confidence_penalty: number
  trade_category_id: number | null
  resolved: boolean
}

interface QuoteSummary {
  total_cost: number
  margin_pct: number
  /** total_cost marked up by margin_pct — what the client is quoted */
  client_price: number
  /** "excl. GST" — see lib/pricing.ts PRICE_BASIS_LABEL for the product decision this reflects. */
  price_basis: string
  price_disclaimer: string
  confidence_score: number
  /** "How reliable is this PRICE" — quotes.confidence_score, renamed for display only. Alias of confidence_score. */
  pricing_confidence: number
  /** "Is the SCOPE complete and internally consistent" — independent of pricing. Null until QA has run. See lib/estimating/qa.ts. */
  scope_confidence: number | null
  /** MIN(pricing_confidence, scope_confidence) — the weakest of the two. Null until QA has run. */
  overall_estimate_confidence: number | null
  unresolved_count: number
  assumption_count: number
  /** Included items with no total that nothing else surfaces — each adds $0. */
  unpriced_count: number
  /** The one builder-facing trust state — see lib/estimating/readiness.ts. */
  readiness: QuoteReadiness
  blocked_reasons: string[]
  review_reasons: string[]
  can_send: boolean
  /** "We assumed these — review them." Empty unless a blocking question was answered with a disclosed default instead of stopping the pipeline. */
  critical_assumptions: CriticalAssumption[]
}

/** Per-source-document accounting written by the estimating engine — see
 *  migration 039 and quotes.document_contribution. */
interface DocumentContribution {
  documents: Array<{ document_id: string; name: string; facts_extracted: number; facts_used: number }>
  other_sources: { facts_extracted: number; facts_used: number } | null
  excluded: string[]
  failed: string[]
  generated_at?: string
}

interface QuoteResponse {
  quote: DemoQuote
  line_items_by_category: LineItemsByCategory[]
  summary: QuoteSummary
  /** Stage 8 QA output — "what should I check?" — now actually delivered. */
  qa_report: QAReport | null
  /** "Did WorkA actually use my drawings?" — null for pre-039 quotes. */
  document_contribution: DocumentContribution | null
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

function computeSummary(
  quote: DemoQuote,
  items: DemoQuoteLineItem[],
  qaReport: QAReport | null,
  criticalAssumptions: CriticalAssumption[] = [],
  scopeConfidence: number | null = null,
  overallEstimateConfidence: number | null = null
): QuoteSummary {
  const unresolved_count = items.filter(
    (i) => i.is_assumption && i.assumption_status === 'unresolved'
  ).length

  const assumption_count = items.filter((i) => i.is_assumption).length
  const unpriced_count = items.filter((i) => isSilentlyUnpriced(i)).length
  const unresolvedConservativeAssumptions = criticalAssumptions.filter((a) => !a.resolved).length

  const { readiness, blockedReasons, reviewReasons } = deriveQuoteReadiness({
    unresolvedAssumptions: unresolved_count,
    unpricedItems: unpriced_count,
    topRiskCount: qaReport?.top_risks?.length ?? 0,
    reviewItemCount: qaReport?.review_items?.length ?? 0,
    confidenceScore: quote.confidence_score,
    unresolvedConservativeAssumptions,
    missingTradeCount: qaReport?.missing_trade_details?.length ?? 0,
  })

  return {
    total_cost: quote.total_cost,
    margin_pct: quote.margin_pct,
    // Canonical: sum of each item's own margin_pct-marked-up total, never
    // total_cost * quote.margin_pct — see calculateClientPrice's own doc
    // comment (lib/pricing.ts) for why that blanket formula disagreed with
    // what this same response's line items display.
    client_price: calculateClientPrice(items),
    price_basis: PRICE_BASIS_LABEL,
    price_disclaimer: CLIENT_PRICE_DISCLAIMER,
    confidence_score: quote.confidence_score,
    pricing_confidence: quote.confidence_score,
    scope_confidence: scopeConfidence,
    overall_estimate_confidence: overallEstimateConfidence,
    unresolved_count,
    assumption_count,
    unpriced_count,
    readiness,
    blocked_reasons: blockedReasons,
    review_reasons: reviewReasons,
    // A blocked quote must never present as sendable — the send routes
    // enforce the same rule server-side, so this is display truth, not the
    // only line of defense.
    can_send: readiness !== 'blocked',
    critical_assumptions: criticalAssumptions,
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
    const summary = computeSummary(DEMO_QUOTE, DEMO_LINE_ITEMS, null)

    const response: QuoteResponse = {
      quote: DEMO_QUOTE,
      line_items_by_category,
      summary,
      qa_report: null,
      document_contribution: null,
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
        qa_report,
        overall_confidence,
        scope_confidence,
        overall_estimate_confidence,
        document_contribution,
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

    // Backfill: quotes created before pricing ran (or where the intake poller
    // dropped) still have no rates — price them on first view. Previously
    // gated on `quoteRow.total_cost === null`, which only ever caught a quote
    // that had NEVER been priced at all — a quote already priced once but
    // whose Stage 6 completeness-recovery pass (smooth-responder/index.ts)
    // later added MORE line items across a separate, recovery-cron-triggered
    // invocation (a normal, documented outcome of that resumable design, not
    // a failure) kept total_cost non-null forever, so the newly-added items
    // stayed permanently unpriced and total_cost silently drifted from the
    // true line-item sum — confirmed live on a real project (52 -> 234 line
    // items across invocations; total_cost never moved off its first-pass
    // value). ensureQuotePriced is itself cheap and idempotent when there is
    // nothing left to price (two lightweight fetches, no writes), so calling
    // it unconditionally here is the backfill this comment already promised,
    // not a new cost.
    {
      const wasPriced = await ensureQuotePriced(supabase, quoteId)
      if (wasPriced) {
        const { data: repriced } = await supabase
          .from('quotes')
          .select('total_cost, margin_pct, confidence_score')
          .eq('id', quoteId)
          .single()
        if (repriced) {
          quoteRow.total_cost = repriced.total_cost
          quoteRow.margin_pct = repriced.margin_pct
          quoteRow.confidence_score = repriced.confidence_score
        }
      }
    }

    // Fetch line items with trade categories.
    //
    // The migration-012 columns (pricing_type, source_ref, margin_pct, and the
    // cost splits) may not exist yet on databases where that migration hasn't
    // been applied. Try the enriched select first, and if Postgres reports a
    // missing column, fall back to the base columns that predate migration 012.
    // The mapping below reads every migration-012 field defensively (`?? default`),
    // so a base-only row degrades cleanly.
    const BASE_LINE_COLUMNS = `
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
      `
    const ENRICHED_LINE_COLUMNS = `
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
        pricing_type,
        source_ref,
        margin_pct,
        labour_cost,
        material_cost,
        subcontract_cost,
        plant_cost,
        pricing_source,
        pricing_basis,
        trade_categories (
          id,
          name
        )
      `

    let { data: lineRows, error: lineErr } = await supabase
      .from('quote_line_items')
      .select(ENRICHED_LINE_COLUMNS)
      .eq('quote_id', quoteId)
      .order('trade_category_id', { ascending: true })

    // Postgres error 42703 = undefined_column. Some client versions only surface
    // it in the message, so match on either signal before retrying.
    const isMissingColumn =
      lineErr != null &&
      ((lineErr as { code?: string }).code === '42703' ||
        /does not exist/i.test(lineErr.message))

    if (isMissingColumn) {
      const fallback = await supabase
        .from('quote_line_items')
        .select(BASE_LINE_COLUMNS)
        .eq('quote_id', quoteId)
        .order('trade_category_id', { ascending: true })
      lineRows = fallback.data as typeof lineRows
      lineErr = fallback.error
    }

    if (lineErr) {
      console.error('[quotes:get] line items fetch error:', lineErr.message, { quoteId })
      return NextResponse.json({ error: 'Failed to load quote line items. Please try again.' }, { status: 500 })
    }

    const jobRow = (quoteRow as typeof quoteRow & { jobs: { address: string } | null }).jobs

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
      const tc = (row as typeof row & { trade_categories: { id: number; name: string } | null }).trade_categories
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
        pricing_type: ((row as Record<string, unknown>).pricing_type ?? 'measured') as DemoQuoteLineItem['pricing_type'],
        source_ref: ((row as Record<string, unknown>).source_ref ?? null) as string | null,
        margin_pct: ((row as Record<string, unknown>).margin_pct ?? 0.15) as number,
        labour_cost: ((row as Record<string, unknown>).labour_cost ?? null) as number | null,
        material_cost: ((row as Record<string, unknown>).material_cost ?? null) as number | null,
        subcontract_cost: ((row as Record<string, unknown>).subcontract_cost ?? null) as number | null,
        plant_cost: ((row as Record<string, unknown>).plant_cost ?? null) as number | null,
        pricing_source: ((row as Record<string, unknown>).pricing_source ?? null) as string | null,
        pricing_basis: ((row as Record<string, unknown>).pricing_basis ?? null) as string | null,
      }
    })

    // Stage 8 QA normally runs from the intake poller right after pricing —
    // but a quote viewed before that ran (or where it failed) would otherwise
    // show no "what to check" list at all. Lazy-run it here exactly once so
    // qa_report is never structurally absent from the review screen. Cheap
    // (a few scoped queries, no AI call) and idempotent.
    let qaReport = (quoteRow as { qa_report?: QAReport | null }).qa_report ?? null
    let scopeConfidence = (quoteRow as { scope_confidence?: number | null }).scope_confidence ?? null
    let overallEstimateConfidence = (quoteRow as { overall_estimate_confidence?: number | null }).overall_estimate_confidence ?? null
    if (!qaReport) {
      try {
        const { runQualityAssurance } = await import('@/lib/estimating/qa')
        qaReport = await runQualityAssurance(supabase, quoteId, quoteRow.job_id)
        // runQualityAssurance writes scope_confidence/overall_estimate_confidence
        // straight to the quotes row — re-read them fresh rather than
        // duplicating that computation here.
        const { data: freshConfidence } = await supabase
          .from('quotes')
          .select('scope_confidence, overall_estimate_confidence')
          .eq('id', quoteId)
          .single()
        scopeConfidence = freshConfidence?.scope_confidence ?? null
        overallEstimateConfidence = freshConfidence?.overall_estimate_confidence ?? null
      } catch (qaErr) {
        console.error('[quotes:get] lazy QA run failed:', qaErr)
      }
    }

    // Non-blocking estimation: conservative assumptions WorkA made in place
    // of an unanswered blocking clarifying question — gate IS NULL is what
    // distinguishes these from Gate 1-3 assumptions (never touched here).
    // line_item_id IS NULL too: a pre-migration-026 legacy Gate 1-3 row can
    // also have gate IS NULL (the column didn't exist yet when it was
    // written), but always has line_item_id set — our new rows never do.
    const { data: criticalAssumptionRows } = await supabase
      .from('assumptions')
      .select('id, description, assumed_value, reason, confidence_penalty, trade_category_id, resolution_type')
      .eq('quote_id', quoteId)
      .is('gate', null)
      .is('line_item_id', null)
      .order('created_at', { ascending: true })

    const criticalAssumptions: CriticalAssumption[] = ((criticalAssumptionRows ?? []) as Array<{
      id: string; description: string; assumed_value: string | null; reason: string | null
      confidence_penalty: number | null; trade_category_id: number | null; resolution_type: string | null
    }>).map((r) => ({
      id: r.id,
      question: r.description,
      assumed_value: r.assumed_value ?? '',
      reason: r.reason ?? '',
      confidence_penalty: r.confidence_penalty ?? 0,
      trade_category_id: r.trade_category_id,
      resolved: r.resolution_type !== null,
    }))

    const line_items_by_category = groupByCategory(items)
    const summary = computeSummary(quote, items, qaReport, criticalAssumptions, scopeConfidence, overallEstimateConfidence)

    const response: QuoteResponse = {
      quote,
      line_items_by_category,
      summary,
      qa_report: qaReport,
      document_contribution: ((quoteRow as { document_contribution?: DocumentContribution | null }).document_contribution) ?? null,
    }

    return NextResponse.json(response)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[quotes:get] unhandled error:', msg, { quoteId: params.quoteId })
    return NextResponse.json({ error: 'Failed to load quote. Please try again.' }, { status: 500 })
  }
}
