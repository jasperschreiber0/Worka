import { NextRequest, NextResponse } from 'next/server'
import { DEMO_QUOTE, DEMO_LINE_ITEMS } from '@/lib/quote-demo'
import type { DemoQuote, DemoQuoteLineItem, EstimateEvidence } from '@/lib/quote-demo'
import type { QAReport } from '@/lib/types/database.types'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { applyMargin, ensureQuotePriced } from '@/lib/pricing'
import { evaluateQualityGate } from '@/lib/estimating/quality-gate'
import type { QualityGateResult } from '@/lib/estimating/quality-gate'

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
  /** total_cost marked up by margin_pct — what the client is quoted */
  client_price: number
  confidence_score: number
  unresolved_count: number
  assumption_count: number
  can_send: boolean
}

/**
 * Stage 6 QA pass output (lib/estimating/qa.ts), passed through unchanged —
 * this route never recomputes QA, only reads what runQualityAssurance already
 * persisted to quotes.qa_report / quotes.overall_confidence.
 */
interface QASummary extends QAReport {
  overall_confidence: number | null
}

interface QuoteResponse {
  quote: DemoQuote
  line_items_by_category: LineItemsByCategory[]
  summary: QuoteSummary
  qa: QASummary | null
  evidence: EstimateEvidence | null
  quality_gate: QualityGateResult
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

// ─── Helper: build QA summary ─────────────────────────────────────────────────
// Pure pass-through of quotes.qa_report / quotes.overall_confidence — never
// recomputed here. runQualityAssurance (lib/estimating/qa.ts) is the one
// place QA is calculated.

function buildQASummary(
  qaReport: QAReport | null | undefined,
  overallConfidence: number | null | undefined
): QASummary | null {
  if (!qaReport) return null
  return { ...qaReport, overall_confidence: overallConfidence ?? null }
}

// ─── Helper: build estimate evidence ──────────────────────────────────────────
// Phase 1.5 — pure aggregation over data that already exists (project_documents,
// files.skipped/failed_sibling_filenames, scope_items, and the quote's own
// line items already fetched below). No new computation, no estimation logic —
// counting existing flags, same spirit as computeSummary below.

interface ProjectDocumentRow {
  document_type: string | null
  is_duplicate: boolean
  is_superseded: boolean
}

interface FileSiblingsRow {
  skipped_sibling_filenames: string[] | null
  failed_sibling_filenames: string[] | null
}

interface ScopeItemRow {
  included_scope: string[] | null
}

function buildEstimateEvidence(
  docRows: ProjectDocumentRow[],
  fileRows: FileSiblingsRow[],
  scopeRows: ScopeItemRow[],
  items: DemoQuoteLineItem[]
): EstimateEvidence {
  // A duplicate/superseded document didn't independently contribute
  // evidence — don't double-count it as a separate document processed.
  const activeDocs = docRows.filter((d) => !d.is_duplicate && !d.is_superseded)
  const documentTypes = Array.from(
    new Set(activeDocs.map((d) => d.document_type).filter((t): t is string => !!t))
  )

  const missingDocuments = Array.from(
    new Set(
      fileRows.flatMap((f) => [
        ...(f.skipped_sibling_filenames ?? []),
        ...(f.failed_sibling_filenames ?? []),
      ])
    )
  )

  const scopeItemsIdentified = scopeRows.reduce((sum, s) => sum + (s.included_scope?.length ?? 0), 0)

  return {
    documents_processed: activeDocs.length,
    document_types: documentTypes,
    missing_documents: missingDocuments,
    scope_items_identified: scopeItemsIdentified,
    line_items_generated: items.length,
    fixed_price_count: items.filter((i) => i.pricing_type === 'measured' && !i.is_assumption).length,
    pc_ps_count: items.filter((i) => i.pricing_type === 'pc_allowance' || i.pricing_type === 'provisional_sum').length,
    assumed_count: items.filter((i) => i.is_assumption).length,
    needs_review_count: items.filter((i) => i.is_assumption && i.assumption_status === 'unresolved').length,
  }
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
    client_price: applyMargin(quote.total_cost, quote.margin_pct),
    confidence_score: quote.confidence_score,
    unresolved_count,
    assumption_count,
    // Naive default — overwritten below from evaluateQualityGate's richer
    // BLOCKED/REVIEW_REQUIRED/READY decision (unresolved_count === 0 is one
    // of several BLOCKED conditions, not the only one).
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
    const qa = buildQASummary(DEMO_QUOTE.qa_report, DEMO_QUOTE.overall_confidence)
    const evidence = DEMO_QUOTE.evidence ?? null
    // Same evaluateQualityGate call as real mode — no separate hand-authored
    // demo gate result, since this is pure arithmetic over data demo mode
    // already has (unlike qa_report, which really is an external artifact).
    const quality_gate = evaluateQualityGate({
      overall_confidence: DEMO_QUOTE.overall_confidence ?? null,
      unresolved_count: summary.unresolved_count,
      missing_trades: qa?.missing_trades ?? [],
      top_risks: qa?.top_risks ?? [],
      total_cost: DEMO_QUOTE.total_cost,
      items: DEMO_LINE_ITEMS,
    })
    summary.can_send = quality_gate.state !== 'blocked'

    const response: QuoteResponse = {
      quote: DEMO_QUOTE,
      line_items_by_category,
      summary,
      qa,
      evidence,
      quality_gate,
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
        risk_acknowledged_at,
        risk_acknowledgement_snapshot,
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
    // dropped) still have no rates — price them on first view
    if (quoteRow.total_cost === null) {
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
      qa_report: (quoteRow.qa_report as QAReport | null) ?? null,
      overall_confidence: quoteRow.overall_confidence ?? null,
      risk_acknowledged_at: quoteRow.risk_acknowledged_at ?? null,
      risk_acknowledgement_snapshot: quoteRow.risk_acknowledgement_snapshot ?? null,
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
      }
    })

    const line_items_by_category = groupByCategory(items)
    const summary = computeSummary(quote, items)
    const qa = buildQASummary(quote.qa_report, quote.overall_confidence)

    // Estimate Evidence (Phase 1.5) — three independent reads scoped to the
    // job, run in parallel. None of this feeds back into pricing or QA.
    const [{ data: docRows }, { data: fileRows }, { data: scopeRows }] = await Promise.all([
      supabase.from('project_documents').select('document_type, is_duplicate, is_superseded').eq('job_id', quote.job_id),
      supabase.from('files').select('skipped_sibling_filenames, failed_sibling_filenames').eq('job_id', quote.job_id),
      supabase.from('scope_items').select('included_scope').eq('job_id', quote.job_id),
    ])
    const evidence = buildEstimateEvidence(
      (docRows ?? []) as ProjectDocumentRow[],
      (fileRows ?? []) as FileSiblingsRow[],
      (scopeRows ?? []) as ScopeItemRow[],
      items
    )

    const quality_gate = evaluateQualityGate({
      overall_confidence: quote.overall_confidence ?? null,
      unresolved_count: summary.unresolved_count,
      missing_trades: qa?.missing_trades ?? [],
      top_risks: qa?.top_risks ?? [],
      total_cost: quote.total_cost,
      items,
    })
    summary.can_send = quality_gate.state !== 'blocked'

    const response: QuoteResponse = {
      quote,
      line_items_by_category,
      summary,
      qa,
      evidence,
      quality_gate,
    }

    return NextResponse.json(response)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[quotes:get] unhandled error:', msg, { quoteId: params.quoteId })
    return NextResponse.json({ error: 'Failed to load quote. Please try again.' }, { status: 500 })
  }
}
