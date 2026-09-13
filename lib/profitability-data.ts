import { createClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { calculateClientPrice } from './pricing'
import {
  profitabilityReview,
  comparableLearning,
  riskSummary,
  type EstimateRow,
  type ActualRow,
  type Candidate,
  type LearningSample,
} from './profitability'
export function intelligenceDB() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error('Database connection is unavailable')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
}
export const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Explicitly page to avoid Supabase's 1000-row default silently truncating financial totals.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function allRows(query: () => any): Promise<any[]> {
  const rows = []
  for (let start = 0; start < 100000; start += 500) {
    const r = await query().range(start, start + 499)
    if (r.error) throw new Error(r.error.message)
    rows.push(...r.data)
    if (r.data.length < 500) return rows
  }
  throw new Error(
    'This review exceeds the supported row count; no partial financial totals were calculated',
  )
}
export async function loadIntelligence(builder: string, jobId: string, quoteId?: string) {
  const db = intelligenceDB()
  const j = await db
    .from('jobs')
    .select('id,address,status,job_type,created_at,profitability_revision')
    .eq('id', jobId)
    .eq('builder_id', builder)
    .maybeSingle()
  if (j.error) throw new Error(j.error.message)
  if (!j.data) throw new Error('Job not found')
  const [
    settingsResult,
    quotes,
    costs,
    labour,
    candidates,
    variations,
    events,
    communication,
    profileResult,
    savedReviews,
  ] = await Promise.all([
    db
      .from('job_profitability_settings')
      .select('*')
      .eq('job_id', jobId)
      .eq('builder_id', builder)
      .maybeSingle(),
    allRows(() =>
      db
        .from('quotes')
        .select('*')
        .eq('job_id', jobId)
        .eq('builder_id', builder)
        .order('version', { ascending: false })
        .order('id'),
    ),
    allRows(() =>
      db
        .from('job_cost_entries')
        .select('*')
        .eq('job_id', jobId)
        .eq('builder_id', builder)
        .order('id'),
    ),
    allRows(() =>
      db
        .from('job_labour_hours')
        .select('*')
        .eq('job_id', jobId)
        .eq('builder_id', builder)
        .order('id'),
    ),
    allRows(() =>
      db
        .from('profitability_candidates')
        .select('*')
        .eq('job_id', jobId)
        .eq('builder_id', builder)
        .order('created_at')
        .order('id'),
    ),
    allRows(() =>
      db.from('variations').select('*').eq('job_id', jobId).eq('builder_id', builder).order('id'),
    ),
    allRows(() =>
      db
        .from('proof_events')
        .select('*')
        .eq('job_id', jobId)
        .eq('builder_id', builder)
        .order('created_at')
        .order('id'),
    ),
    allRows(() =>
      db
        .from('communication_history')
        .select('id,subject,body,timestamp,from_address')
        .eq('job_id', jobId)
        .eq('builder_id', builder)
        .order('timestamp')
        .order('id'),
    ),
    db.from('business_financial_profiles').select('*').eq('builder_id', builder).maybeSingle(),
    allRows(() =>
      db.from('profitability_reviews').select('*').eq('builder_id', builder).order('job_id'),
    ),
  ])
  if (settingsResult.error) throw new Error(settingsResult.error.message)
  if (profileResult.error) throw new Error(profileResult.error.message)
  const quote = quoteId
    ? quotes.find((q) => q.id === quoteId)
    : (quotes.find((q) => q.is_current) ?? quotes[0] ?? null)
  if (quoteId && !quote) throw new Error('Quote not found')
  const items: EstimateRow[] = quote
    ? await allRows(() =>
        db.from('quote_line_items').select('*').eq('quote_id', quote.id).order('id'),
      )
    : []
  const settings = settingsResult.data
  const baseline: EstimateRow[] = settings?.baseline_items?.length
    ? settings.baseline_items
    : items.filter((r) => !r.variation_id)
  const originalContract =
    settings?.original_contract ??
    calculateClientPrice(
      baseline.map((r) => ({ ...r, assumption_status: r.assumption_status ?? null })),
    )
  const approved = variations
    .filter((v) => v.status === 'approved')
    .reduce((s, v) => s + Number(v.amount ?? 0), 0)
  const labourIncluded = settings?.settings?.labourIncluded ?? false
  const actuals: ActualRow[] = [
    ...costs,
    ...(labourIncluded
      ? []
      : labour
          .filter((l) => l.hourly_rate !== null)
          .map((l) => ({
            id: l.id,
            trade_category_id: l.trade_category_id,
            description: l.note || 'Site labour',
            amount: Number(l.hours) * Number(l.hourly_rate),
            labour_hours: Number(l.hours),
            labour_cost: Number(l.hours) * Number(l.hourly_rate),
            incurred_on: l.work_date,
            source_ref: 'Site hours',
          }))),
  ]
  const evidenceKey = fingerprint({
    baseline,
    originalContract,
    approved,
    actuals,
    labour,
    settings: settings?.settings,
  })
  const saved = savedReviews.find((r) => r.job_id === jobId)
  const review = profitabilityReview(
    baseline,
    actuals,
    originalContract,
    approved,
    Boolean(saved && saved.evidence.fingerprint === evidenceKey && saved.evidence.taxReconciled === true && saved.evidence.mappingsConfirmed === true),
    settings?.settings?.estimatedHours ?? {},
  )
  const context = {
    jobId,
    jobType: settings?.settings?.jobType || j.data.job_type || '',
    region: settings?.settings?.region || '',
    complexity: settings?.settings?.complexity || '',
    constructionType: settings?.settings?.constructionType || '',
    size: settings?.settings?.size ?? null,
  }
  const samples: LearningSample[] = savedReviews.filter((r) => r.evidence?.taxReconciled === true && r.evidence?.mappingsConfirmed === true).flatMap((r) =>
    r.review.trades
      .filter((t: { id: number | null }) => t.id !== null)
      .map((t: { id: number; estimated: number; actual: number }) => ({
        ...r.context,
        jobId: r.job_id,
        trade: t.id,
        estimated: t.estimated,
        actual: t.actual,
        complete: true,
      })),
  )
  const mergedCandidates: Candidate[] = candidates.map((c) => {
    const v = variations.find((v) => v.id === c.variation_id)
    return {
      ...c,
      status:
        v &&
        ['approved', 'rejected', 'pending'].includes(v.status) &&
        !['recovered', 'unrecovered', 'completed'].includes(c.status)
          ? v.status === 'pending'
            ? 'sent'
            : v.status
          : c.status,
    }
  })
  const untrackedVariations = variations.filter(
    (v) => !candidates.some((c) => c.variation_id === v.id),
  )
  const ledger = [
    ...events,
    ...communication.map((c) => ({
      id: c.id,
      event_type: 'correspondence',
      description: c.subject || c.body.slice(0, 180),
      created_at: c.timestamp,
      metadata: { source: 'communication_history', person: c.from_address, evidence: c.body },
    })),
    ...costs.map((c) => ({
      id: c.id,
      event_type: 'actual_cost',
      description: c.description,
      created_at: c.created_at,
      metadata: {
        trade_category_id: c.trade_category_id,
        cost_impact: c.amount,
        source: c.source_ref || 'Cost ledger',
        invoice: c.invoice_ref,
      },
    })),
    ...quotes.map((q) => ({
      id: q.id,
      event_type: 'estimate',
      description: `Estimate version ${q.version}`,
      created_at: q.created_at,
      metadata: { quote_id: q.id, status: q.status },
    })),
    ...variations.map((v) => ({
      id: v.id,
      event_type: 'variation',
      description: v.title,
      created_at: v.created_at,
      metadata: {
        trade_category_id: v.trade_category_id,
        revenue_impact: v.amount,
        approval_state: v.status,
      },
    })),
  ].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  const currentItems = items.filter((r) => !r.variation_id && r.assumption_status !== 'excluded')
  const latestRevision = await db.from('jobs').select('profitability_revision').eq('id',jobId).eq('builder_id',builder).single()
  if(latestRevision.error)throw new Error(latestRevision.error.message)
  if(latestRevision.data.profitability_revision!==j.data.profitability_revision)throw new Error('Financial records changed while loading. Refresh to review the latest figures.')
  return {
    job: j.data,
    quote,
    items,
    baseline,
    settings,
    originalContract,
    currentCost: currentItems.reduce((s, r) => s + (r.total ?? 0), 0),
    currentSellPrice: calculateClientPrice(
      currentItems.map((r) => ({ ...r, assumption_status: r.assumption_status ?? null })),
    ),
    currentMissingPrices: currentItems.filter((r) => r.total === null).length,
    approved,
    actuals,
    costs,
    labour,
    uncostedHours: labourIncluded
      ? 0
      : labour.filter((l) => l.hourly_rate === null).reduce((s, l) => s + Number(l.hours), 0),
    candidates: mergedCandidates,
    changesWithoutApprovedVariation: mergedCandidates.filter((c) =>
      c.incurred > 0 && c.status !== 'not_a_change' &&
      !variations.some((v) => v.id === c.variation_id && v.status === 'approved')
    ).length,
    untrackedVariations,
    ledger,
    profile: profileResult.data?.profile ?? null,
    review,
    context,
    learning: comparableLearning(samples, context),
    risk: riskSummary(mergedCandidates),
    evidenceKey,
    savedReview: saved ?? null,
    demo: false,
  }
}
