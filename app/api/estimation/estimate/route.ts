import { NextRequest, NextResponse } from 'next/server'
import { isDemoMode, getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { buildDemoEstimate } from '@/lib/estimate-demo'
import {
  generateEstimateItems,
  assembleEstimate,
  runGuards,
  groupIntoSections,
  contingencyForMaturity,
  basisToPricingType,
  pricingTypeToBasis,
  tradeForSection,
  computeEstimateTotals,
  type PricingMode,
  type EstimateLineItem,
  type GeneratedEstimate,
} from '@/lib/estimate-generation'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ─── POST /api/estimation/estimate ────────────────────────────────────────────
// Generate the reasoned line-item estimate from the stored scope. Runs the three
// anti-fabrication guards. Demo mode returns the 16 Alfred St fixture.

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { job_id?: string; pricing_mode?: PricingMode; file_ids?: string[] }
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const requestedMode: PricingMode = body.pricing_mode === 'user_supplied' ? 'user_supplied' : 'market'

  if (isDemoMode()) {
    return NextResponse.json({ estimate: buildDemoEstimate(requestedMode), demo: true })
  }

  const jobId = body.job_id
  if (!jobId) return NextResponse.json({ error: 'job_id required' }, { status: 400 })

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!supabaseUrl || !supabaseKey) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
  if (!anthropicKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })

  const pricingMode: PricingMode = requestedMode

  try {
    const { createClient } = await import('@supabase/supabase-js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = createClient(supabaseUrl, supabaseKey)

    // ── Load the reasoned scope + document authors (for the branding guard) ──
    const [{ data: scopeRow }, { data: docRows }] = await Promise.all([
      supabase.from('project_scope').select('*').eq('builder_id', builderId).eq('job_id', jobId).maybeSingle(),
      supabase.from('documents').select('author, issue_status, category').eq('builder_id', builderId).eq('job_id', jobId),
    ])
    if (!scopeRow) return NextResponse.json({ error: 'No project scope found — run the assessment first.' }, { status: 400 })

    const scopeSummary = buildScopeSummary(scopeRow)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const documentAuthors: string[] = (docRows ?? []).map((d: any) => d.author).filter((a: unknown): a is string => Boolean(a))

    // ── Generate line items ──────────────────────────────────────────────────
    const gen = await generateEstimateItems(anthropicKey, [], scopeSummary, pricingMode)
    let items = gen.items
    const confidenceSummary = gen.confidenceSummary
    if (items.length === 0) return NextResponse.json({ error: 'Estimate generation produced no line items.' }, { status: 502 })

    // ── User-supplied rate library — match line-by-line, flag unmatched ──────
    let rateMatch
    if (pricingMode === 'user_supplied') {
      const { applyRateLibrary } = await import('@/lib/rate-library')
      const library = await loadRateLibrary(supabase, builderId)
      const res = applyRateLibrary(items, library)
      items = res.items
      rateMatch = { matched: res.matched, unmatched: res.unmatched, unmatched_items: res.unmatched_items }
    }

    // ── Guards ───────────────────────────────────────────────────────────────
    const guardWarnings = runGuards({
      items,
      branding: { settingsCompany: null, candidateCompany: null, documentAuthors },
    })

    // Contingency scales with the least-mature issue status among the documents.
    const maturity = leastMatureStatus((docRows ?? []).map((d: { issue_status?: string }) => d.issue_status))
    const estimate = assembleEstimate({
      items,
      contingencyPct: contingencyForMaturity(maturity),
      isIndicative: scopeRow.is_indicative ?? true,
      pricingMode,
      guardWarnings,
      branding: { company_name: null, contact: null },
      confidenceSummary,
      rateMatch,
      demo: false,
    })

    // ── Persist (best-effort) ────────────────────────────────────────────────
    await persistEstimate(supabase, builderId, jobId, estimate).catch((e) =>
      console.error('[estimate:persist]', e instanceof Error ? e.message : String(e))
    )

    return NextResponse.json({ estimate, demo: false })
  } catch (err) {
    console.error('[estimate:error]', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Could not generate the estimate. Please try again.' }, { status: 500 })
  }
}

// ─── GET /api/estimation/estimate?job_id= ─────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (isDemoMode()) {
    return NextResponse.json({ estimate: buildDemoEstimate(), demo: true })
  }

  const jobId = new URL(req.url).searchParams.get('job_id')
  if (!jobId) return NextResponse.json({ error: 'job_id required' }, { status: 400 })

  try {
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
    if (!quoteRow) return NextResponse.json({ estimate: null, demo: false })

    const [{ data: liRows }, { data: scopeRow }] = await Promise.all([
      supabase.from('quote_line_items').select('*').eq('quote_id', quoteRow.id),
      supabase.from('project_scope').select('is_indicative').eq('builder_id', builderId).eq('job_id', jobId).maybeSingle(),
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
    const totals = computeEstimateTotals(
      tradeSubtotal,
      quoteRow.contingency_pct ?? 10,
      quoteRow.margin_pct ?? 18,
      quoteRow.gst_pct ?? 10
    )
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
    return NextResponse.json({ estimate, demo: false })
  } catch (err) {
    console.error('[estimate:get]', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Could not load the estimate.' }, { status: 500 })
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildScopeSummary(scope: any): string {
  const parts: string[] = []
  parts.push(`PROJECT: ${scope.project_type ?? 'Residential construction'}`)
  if (scope.complexity_rating) parts.push(`Complexity: ${scope.complexity_rating}`)
  if (Array.isArray(scope.scope_summary) && scope.scope_summary.length) {
    parts.push('Scope:\n' + scope.scope_summary.map((s: string) => `- ${s}`).join('\n'))
  }
  if (scope.site_data) {
    const sd = scope.site_data
    parts.push(`Site: ${[sd.address, sd.zoning, sd.proposed_gfa_m2 ? `${sd.proposed_gfa_m2}m² proposed GFA` : null].filter(Boolean).join(', ')}`)
  }
  if (Array.isArray(scope.specialty_inclusions) && scope.specialty_inclusions.length) {
    parts.push('Specialty inclusions:\n' + scope.specialty_inclusions.map((s: { item: string }) => `- ${s.item}`).join('\n'))
  }
  if (Array.isArray(scope.trade_list) && scope.trade_list.length) {
    parts.push('Trades in scope:\n' + scope.trade_list.map((t: { trade: string; reason: string }) => `- ${t.trade}: ${t.reason}`).join('\n'))
  }
  if (Array.isArray(scope.risks) && scope.risks.length) {
    parts.push('Risks/gaps (price affected scope as provisional):\n' + scope.risks.map((r: string) => `- ${r}`).join('\n'))
  }
  return parts.join('\n\n')
}

// Load the builder's rate library from their stored supplier rates + manual
// preferences (the same rows the 5-tier engine reads). Description/unit/trade
// columns are best-effort — the matcher tolerates nulls.
async function loadRateLibrary(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  builderId: string
): Promise<import('@/lib/rate-library').RateLibraryEntry[]> {
  const [{ data: supplier }, { data: prefs }] = await Promise.all([
    supabase.from('builder_supplier_rates').select('*').eq('builder_id', builderId),
    supabase.from('builder_rate_preferences').select('*').eq('builder_id', builderId),
  ])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toEntry = (r: any) => ({
    key: r.line_item_key ?? null,
    description: r.description ?? null,
    unit: r.unit ?? null,
    rate: typeof r.rate === 'number' ? r.rate : parseFloat(r.rate),
    trade_category_id: r.trade_category_id ?? null,
  })
  return [...(supplier ?? []), ...(prefs ?? [])]
    .map(toEntry)
    .filter((e) => Number.isFinite(e.rate) && e.rate > 0)
}

function leastMatureStatus(statuses: Array<string | undefined>): string {
  const order = ['concept', 'da', 'da_modification', 'draft', 'cdc', 'cc', 'ifc']
  let worst = 'unknown'
  let worstIdx = 999
  for (const s of statuses) {
    if (!s) continue
    const idx = order.indexOf(s)
    if (idx >= 0 && idx < worstIdx) {
      worstIdx = idx
      worst = s
    }
  }
  return worst
}

async function persistEstimate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  builderId: string,
  jobId: string,
  estimate: GeneratedEstimate
): Promise<void> {
  const { data: quoteRow } = await supabase
    .from('quotes')
    .insert({
      job_id: jobId,
      builder_id: builderId,
      status: 'draft',
      total_cost: estimate.totals.trade_subtotal,
      margin_pct: estimate.totals.margin_pct,
      contingency_pct: estimate.totals.contingency_pct,
      gst_pct: estimate.totals.gst_pct,
      version: 1,
    })
    .select()
    .single()
  if (!quoteRow) return

  const flat = estimate.sections.flatMap((s) => s.items)
  const inserts = flat.map((i) => ({
    quote_id: quoteRow.id,
    trade_category_id: i.trade_category_id,
    description: i.description,
    quantity: i.quantity,
    unit: i.unit,
    rate: i.rate,
    total: i.total,
    confidence: i.confidence,
    pricing_type: basisToPricingType(i.basis),
    basis: i.basis,
    estimate_section: i.section,
    location_scope: i.location_scope,
    source_ref: i.source_ref,
    notes: i.notes,
    margin_pct: i.basis === 'provisional' ? 0 : estimate.totals.margin_pct / 100,
  }))
  if (inserts.length > 0) {
    await supabase.from('quote_line_items').insert(inserts)
  }
}
