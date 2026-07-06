import { NextRequest, NextResponse } from 'next/server'
import { isDemoMode, getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { buildDemoEstimate } from '@/lib/estimate-demo'
import { DEMO_ASSESSMENT } from '@/lib/estimation-assessment-demo'
import {
  buildEstimateWorkbook,
  buildBuilderHtml,
  buildClientQuoteHtml,
  type ExportMeta,
} from '@/lib/estimate-export'
import {
  groupIntoSections,
  computeEstimateTotals,
  tradeForSection,
  pricingTypeToBasis,
  type GeneratedEstimate,
  type EstimateLineItem,
  type PricingMode,
} from '@/lib/estimate-generation'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// ─── GET /api/estimation/estimate/export?job_id=&format=xlsx|pdf|client ────────
// Streams the reasoned estimate as an Excel workbook (live formulas), a builder
// PDF (print-ready HTML), or a room-grouped client quotation. Every output
// carries the indicative header when applicable; branding comes only from
// settings.

export async function GET(req: NextRequest): Promise<NextResponse | Response> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const format = (url.searchParams.get('format') ?? 'xlsx').toLowerCase()
  const jobId = url.searchParams.get('job_id')
  const pricingMode: PricingMode = url.searchParams.get('pricing_mode') === 'user_supplied' ? 'user_supplied' : 'market'

  // ── Resolve the estimate + export metadata ─────────────────────────────────
  let estimate: GeneratedEstimate | null = null
  let meta: ExportMeta

  if (isDemoMode()) {
    estimate = buildDemoEstimate(pricingMode)
    const scope = DEMO_ASSESSMENT.scope
    meta = {
      projectName: scope.project_type,
      address: scope.site_data.address,
      isIndicative: estimate.is_indicative,
      branding: { company_name: null, contact: null }, // demo has no company settings — never invented
      assumptions: scope.assumptions,
      exclusions: scope.exclusions,
      risks: scope.risks,
      pricingMode,
    }
  } else {
    if (!jobId) return NextResponse.json({ error: 'job_id required' }, { status: 400 })
    const built = await loadEstimateForJob(builderId, jobId)
    if (!built) return NextResponse.json({ error: 'No estimate found for this job.' }, { status: 404 })
    estimate = built.estimate
    meta = built.meta
  }

  const safeName = meta.projectName.replace(/[^a-z0-9]+/gi, '-').slice(0, 40).replace(/^-|-$/g, '') || 'estimate'

  // ── Render ─────────────────────────────────────────────────────────────────
  if (format === 'xlsx') {
    const buf = buildEstimateWorkbook(estimate, meta)
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${safeName}-estimate.xlsx"`,
      },
    })
  }

  if (format === 'client') {
    return new Response(buildClientQuoteHtml(estimate, meta), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  // default: builder PDF (HTML, print-to-PDF)
  return new Response(buildBuilderHtml(estimate, meta), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

// ─── Real-mode load: rebuild the estimate + meta from stored rows ─────────────

async function loadEstimateForJob(
  builderId: string,
  jobId: string
): Promise<{ estimate: GeneratedEstimate; meta: ExportMeta } | null> {
  const { createClient } = await import('@supabase/supabase-js')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  const { data: quoteRow } = await supabase
    .from('quotes')
    .select('id, contingency_pct, margin_pct, gst_pct')
    .eq('builder_id', builderId)
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!quoteRow) return null

  const [{ data: liRows }, { data: scopeRow }] = await Promise.all([
    supabase.from('quote_line_items').select('*').eq('quote_id', quoteRow.id),
    supabase.from('project_scope').select('*').eq('builder_id', builderId).eq('job_id', jobId).maybeSingle(),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: EstimateLineItem[] = (liRows ?? []).map((r: any) => ({
    section: r.estimate_section ?? 'preliminaries',
    trade_category_id: r.trade_category_id ?? tradeForSection(r.estimate_section ?? 'preliminaries'),
    description: r.description,
    location_scope: r.location_scope ?? 'general',
    source_ref: r.source_ref ?? null,
    quantity: r.quantity ?? null,
    unit: r.unit ?? null,
    rate: r.rate ?? null,
    total: r.total ?? null,
    basis: r.basis ?? pricingTypeToBasis(r.pricing_type ?? 'measured'),
    confidence: r.confidence ?? 50,
    notes: r.notes ?? null,
  }))

  const sections = groupIntoSections(items)
  const tradeSubtotal = sections.reduce((s, g) => s + g.subtotal, 0)
  const totals = computeEstimateTotals(tradeSubtotal, quoteRow.contingency_pct ?? 10, quoteRow.margin_pct ?? 18, quoteRow.gst_pct ?? 10)

  const estimate: GeneratedEstimate = {
    sections,
    line_count: items.length,
    totals,
    is_indicative: scopeRow?.is_indicative ?? true,
    pricing_mode: 'market',
    guard_warnings: [],
    branding: { company_name: null, contact: null },
    confidence_summary: '',
    generated_at: new Date().toISOString(),
    demo: false,
  }

  const meta: ExportMeta = {
    projectName: scopeRow?.project_type ?? 'Estimate',
    address: scopeRow?.site_data?.address ?? null,
    isIndicative: estimate.is_indicative,
    // Branding strictly from company settings — not present here → stays null.
    branding: { company_name: null, contact: null },
    assumptions: scopeRow?.assumptions ?? [],
    exclusions: scopeRow?.exclusions ?? [],
    risks: scopeRow?.risks ?? [],
    pricingMode: 'market',
  }

  return { estimate, meta }
}
