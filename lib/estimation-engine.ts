// ─── WorkA Parametric Estimator ─────────────────────────────────────────────
//
// Produces a fast, defensible job estimate from the builder's OWN history —
// the ChatGPT-style "give me a number" experience, but grounded in real past
// jobs instead of a guess. The equation:
//
//   client_price = floor_area  ×  ($/m² blended from similar past jobs)
//
// where the blend is weighted by how similar each past job is to the new one.
// Every number traces back to real projects the builder actually delivered,
// with a per-trade breakdown, a low–high range, and a confidence score — the
// things a lump-sum LLM guess can never give you.

import type { ProjectMetadata, SimilarProject } from '@/lib/types/estimation.types'

// ─── Similarity scoring (structured, no embeddings) ──────────────────────────
// Single source of truth — the similar-jobs route imports this too.

export function scoreProject(
  candidate: SimilarProject,
  query: ProjectMetadata
): { score: number; reasons: string[] } {
  let score = 0
  const reasons: string[] = []

  // Job type (30pts)
  if (candidate.job_type && candidate.job_type === query.job_type) {
    score += 30
    reasons.push('Same job type')
  } else if (candidate.job_type && query.job_type) {
    const related: Record<string, string[]> = {
      rear_extension: ['side_extension', 'full_renovation'],
      side_extension: ['rear_extension'],
      full_renovation: ['rear_extension', 'kitchen_reno', 'bathroom_reno'],
    }
    if (related[query.job_type]?.includes(candidate.job_type)) {
      score += 12
      reasons.push('Related job type')
    }
  }

  // Floor area (20pts)
  if (candidate.floor_area_m2 && query.floor_area_m2) {
    const pctDiff = Math.abs(candidate.floor_area_m2 - query.floor_area_m2) / query.floor_area_m2
    if (pctDiff < 0.1) { score += 20; reasons.push('Very similar floor area') }
    else if (pctDiff < 0.2) { score += 15; reasons.push(`Similar floor area (${Math.round(pctDiff * 100)}%)`) }
    else if (pctDiff < 0.35) { score += 8; reasons.push('Floor area within 35%') }
  }

  // Region (15pts)
  if (candidate.region && candidate.region === query.region) {
    score += 15; reasons.push('Same state')
  } else if (candidate.region && query.region) {
    score += 4; reasons.push('Different state')
  }

  // Finish level (15pts)
  if (candidate.finish_level === query.finish_level) {
    score += 15; reasons.push('Same finish level')
  } else if (candidate.finish_level && query.finish_level) {
    const levels = ['budget', 'standard', 'premium', 'luxury']
    const diff = Math.abs(levels.indexOf(candidate.finish_level) - levels.indexOf(query.finish_level))
    if (diff === 1) { score += 8; reasons.push('Adjacent finish level') }
  }

  // Wet areas (10pts)
  if (candidate.wet_areas != null && query.wet_areas != null) {
    const diff = Math.abs(candidate.wet_areas - query.wet_areas)
    if (diff === 0) { score += 10; reasons.push('Same wet area count') }
    else if (diff === 1) { score += 5; reasons.push('Wet areas within 1') }
  }

  // Storeys (10pts)
  if (candidate.storeys != null && query.storeys != null && candidate.storeys === query.storeys) {
    score += 10; reasons.push('Same number of storeys')
  }

  return { score: Math.min(score, 100), reasons }
}

// ─── Indicative per-trade allocation ─────────────────────────────────────────
// A typical residential cost split across the 13 locked trade categories. Used
// only to break the total into a readable per-trade shape — labelled as
// indicative, never presented as measured. Sums to 100.

export const TRADE_ALLOCATION: Array<{ id: number; name: string; pct: number }> = [
  { id: 1,  name: 'Site & Earthworks',      pct: 8 },
  { id: 2,  name: 'Concrete',               pct: 9 },
  { id: 3,  name: 'Framing & Structural',   pct: 12 },
  { id: 4,  name: 'Roofing',                pct: 7 },
  { id: 5,  name: 'Windows & Doors',        pct: 8 },
  { id: 6,  name: 'External Cladding',      pct: 6 },
  { id: 7,  name: 'Insulation',             pct: 2 },
  { id: 8,  name: 'Internal Linings',       pct: 7 },
  { id: 9,  name: 'Joinery & Cabinetry',    pct: 15 },
  { id: 10, name: 'Painting',               pct: 5 },
  { id: 11, name: 'Plumbing',               pct: 9 },
  { id: 12, name: 'Electrical',             pct: 7 },
  { id: 13, name: 'Tiling & Finishes',      pct: 5 },
]

// ─── Result shape ────────────────────────────────────────────────────────────

export interface EstimateComparable {
  id: string
  summary: string
  floor_area_m2: number | null
  region: string | null
  cost: number
  cost_per_m2: number
  similarity_score: number
  /** how far the final landed from the quote, e.g. +6.5% */
  final_vs_quoted_pct: number | null
}

export interface EstimateTradeLine {
  trade_category_id: number
  name: string
  pct: number
  amount: number
}

export interface EstimateResult {
  ok: boolean
  reason?: string
  floor_area_m2: number
  cost_per_m2: number
  cost_before_margin: number
  margin_pct: number
  client_price: number
  range_low: number
  range_high: number
  confidence: number
  basis: string
  drivers: string[]
  per_trade: EstimateTradeLine[]
  comparables: EstimateComparable[]
  comparable_count: number
}

function round(n: number): number { return Math.round(n) }

/**
 * Blend a client $/m² from the comparables (weighted by similarity), scale it
 * by the new job's floor area, and derive the cost / margin / range / per-trade
 * breakdown. Comparable "cost" is treated as the delivered job value (what the
 * builder charged), so the estimate is a client price; cost-before-margin is
 * backed out with the builder's typical margin.
 */
export function estimateFromComparables(
  query: ProjectMetadata,
  comparables: SimilarProject[],
  marginPct: number
): EstimateResult {
  const area = query.floor_area_m2 ?? 0

  const base: EstimateResult = {
    ok: false, floor_area_m2: area, cost_per_m2: 0, cost_before_margin: 0,
    margin_pct: marginPct, client_price: 0, range_low: 0, range_high: 0,
    confidence: 0, basis: '', drivers: [], per_trade: [], comparables: [], comparable_count: 0,
  }

  if (!area || area <= 0) {
    return { ...base, reason: 'Enter the floor area to estimate.' }
  }

  // Keep comparables that carry a usable cost + area, prefer final (actual) cost.
  const usable: EstimateComparable[] = comparables
    .map((c) => {
      const cost = c.final_cost ?? c.quoted_cost
      if (!cost || !c.floor_area_m2 || c.floor_area_m2 <= 0) return null
      const finalVsQuoted =
        c.final_cost != null && c.quoted_cost ? ((c.final_cost - c.quoted_cost) / c.quoted_cost) * 100 : null
      return {
        id: c.id,
        summary: c.project_summary,
        floor_area_m2: c.floor_area_m2,
        region: c.region,
        cost,
        cost_per_m2: cost / c.floor_area_m2,
        similarity_score: c.similarity_score,
        final_vs_quoted_pct: finalVsQuoted == null ? null : Math.round(finalVsQuoted * 10) / 10,
      } as EstimateComparable
    })
    .filter((c): c is EstimateComparable => c !== null)

  if (usable.length === 0) {
    return { ...base, reason: 'No comparable past jobs with cost data yet — upload a few completed jobs to seed your history.' }
  }

  // Similarity-weighted blend of $/m².
  const wSum = usable.reduce((s, c) => s + c.similarity_score, 0)
  const blendedCpm = usable.reduce((s, c) => s + c.cost_per_m2 * c.similarity_score, 0) / (wSum || 1)

  const clientPrice = round(area * blendedCpm)
  const costBeforeMargin = round(clientPrice / (1 + marginPct / 100))

  // Range from the spread of comparable rates.
  const cpms = usable.map((c) => c.cost_per_m2)
  const lowCpm = Math.min(...cpms)
  const highCpm = Math.max(...cpms)

  // Confidence: average similarity, dampened by thin evidence and high spread.
  const avgSim = usable.reduce((s, c) => s + c.similarity_score, 0) / usable.length
  const countFactor = Math.min(1, usable.length / 3)
  const mean = cpms.reduce((s, v) => s + v, 0) / cpms.length
  const variance = cpms.reduce((s, v) => s + (v - mean) ** 2, 0) / cpms.length
  const coeffVar = mean > 0 ? Math.sqrt(variance) / mean : 0
  const spreadFactor = 1 - Math.min(0.4, coeffVar)
  const confidence = Math.max(20, Math.min(99, round(avgSim * countFactor * spreadFactor)))

  // Per-trade breakdown (indicative), forced to sum exactly to the client price.
  const per_trade: EstimateTradeLine[] = TRADE_ALLOCATION.map((t) => ({
    trade_category_id: t.id, name: t.name, pct: t.pct, amount: round((clientPrice * t.pct) / 100),
  }))
  const allocated = per_trade.reduce((s, t) => s + t.amount, 0)
  if (per_trade.length > 0) per_trade[per_trade.length - 1].amount += clientPrice - allocated

  const regions = Array.from(new Set(usable.map((c) => c.region).filter(Boolean)))
  const finish = query.finish_level ? `${query.finish_level} ` : ''
  const type = (query.job_type ?? 'residential').replace(/_/g, ' ')

  const drivers = [
    `${usable.length} comparable ${finish}${type} job${usable.length !== 1 ? 's' : ''} in your history` +
      (regions.length ? ` (${regions.join(', ')})` : ''),
    `Delivered rate $${round(lowCpm).toLocaleString()}–$${round(highCpm).toLocaleString()}/m² → blended $${round(blendedCpm).toLocaleString()}/m²`,
    `${area.toLocaleString()} m² at ${marginPct}% margin`,
  ]

  return {
    ok: true,
    floor_area_m2: area,
    cost_per_m2: round(blendedCpm),
    cost_before_margin: costBeforeMargin,
    margin_pct: marginPct,
    client_price: clientPrice,
    range_low: round(area * lowCpm),
    range_high: round(area * highCpm),
    confidence,
    basis: `Blended from ${usable.length} similar past job${usable.length !== 1 ? 's' : ''}, weighted by similarity.`,
    drivers,
    per_trade,
    comparables: usable.sort((a, b) => b.similarity_score - a.similarity_score),
    comparable_count: usable.length,
  }
}
