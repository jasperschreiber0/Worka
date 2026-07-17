// ─── Quality-aware sending gate ────────────────────────────────────────────────
// Decides BLOCKED / REVIEW_REQUIRED / READY for a quote. Pure function, no DB
// access, no side effects — callable identically from demo mode and real mode,
// and from both the quote GET route (display) and confirm-send route (server-
// side enforcement), so there is exactly one place this decision is made.
//
// Does NOT change qa_report, pricing, or estimation logic — this reads their
// already-computed output (overall_confidence, qa_report.top_risks/missing_trades,
// quote_line_items) and adds one new decision layer on top.

export const REVIEW_CONFIDENCE_THRESHOLD = 70
export const REVIEW_EXPOSURE_PCT_THRESHOLD = 10

export type QualityState = 'ready' | 'review_required' | 'blocked'

export type ExposureReason =
  | 'pc_allowance'
  | 'provisional_sum'
  | 'unresolved_assumption'
  | 'resolved_assumption'
  | 'unpriced'

export interface AffectedLineItem {
  id: string
  description: string
  value: number | null
  reason: ExposureReason
}

export interface ExposureBreakdown {
  pc_allowance_value: number
  provisional_sum_value: number
  unresolved_assumption_value: number
  resolved_assumption_value: number
  exposed_value: number
  exposed_pct: number
}

export interface QualityGateResult {
  state: QualityState
  blocked_reasons: string[]
  review_reasons: string[]
  exposure: ExposureBreakdown
  affected_line_items: AffectedLineItem[]
  missing_trade_ids: number[]
}

export interface QualityGateLineItem {
  id: string
  description: string
  total: number | null
  rate: number | null
  pricing_type: 'measured' | 'pc_allowance' | 'provisional_sum'
  is_assumption: boolean
  assumption_status: 'unresolved' | 'accepted' | 'adjusted' | 'excluded' | null
}

export interface QualityGateInput {
  overall_confidence: number | null
  unresolved_count: number
  missing_trades: number[]
  top_risks: string[]
  total_cost: number
  items: QualityGateLineItem[]
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function evaluateQualityGate(input: QualityGateInput): QualityGateResult {
  const { overall_confidence, unresolved_count, missing_trades, top_risks, total_cost, items } = input

  // ── Exposure breakdown — mutually exclusive categorisation per item, so
  // the four buckets sum to exposed_value with no double-counting. PC/PS
  // classification takes precedence over the assumption flag: an item's
  // pricing_type is the more specific, dominant reason its cost is variable,
  // even if it also happens to be flagged as an assumption. ──
  let pcAllowanceValue = 0
  let provisionalSumValue = 0
  let unresolvedAssumptionValue = 0
  let resolvedAssumptionValue = 0
  const affectedLineItems: AffectedLineItem[] = []

  for (const item of items) {
    const isExcluded = item.assumption_status === 'excluded'

    // Integrity failure, not uncertainty — a real, non-excluded quantity
    // silently contributing $0. Feeds blocked_reasons below, not exposure.
    if (!isExcluded && item.rate === null) {
      affectedLineItems.push({ id: item.id, description: item.description, value: null, reason: 'unpriced' })
      continue
    }

    if (isExcluded) continue // excluded items already contribute nothing to total_cost

    const value = item.total ?? 0

    if (item.pricing_type === 'pc_allowance') {
      pcAllowanceValue += value
      affectedLineItems.push({ id: item.id, description: item.description, value, reason: 'pc_allowance' })
    } else if (item.pricing_type === 'provisional_sum') {
      provisionalSumValue += value
      affectedLineItems.push({ id: item.id, description: item.description, value, reason: 'provisional_sum' })
    } else if (item.is_assumption && item.assumption_status === 'unresolved') {
      unresolvedAssumptionValue += value
      affectedLineItems.push({ id: item.id, description: item.description, value, reason: 'unresolved_assumption' })
    } else if (item.is_assumption && (item.assumption_status === 'accepted' || item.assumption_status === 'adjusted')) {
      // An accepted/adjusted assumption is still a judgement call, not
      // verified evidence — included in exposure per that reasoning.
      resolvedAssumptionValue += value
      affectedLineItems.push({ id: item.id, description: item.description, value, reason: 'resolved_assumption' })
    }
  }

  const exposedValue = round2(
    pcAllowanceValue + provisionalSumValue + unresolvedAssumptionValue + resolvedAssumptionValue
  )
  const exposedPct = total_cost > 0 ? round2((exposedValue / total_cost) * 100) : 0

  const exposure: ExposureBreakdown = {
    pc_allowance_value: round2(pcAllowanceValue),
    provisional_sum_value: round2(provisionalSumValue),
    unresolved_assumption_value: round2(unresolvedAssumptionValue),
    resolved_assumption_value: round2(resolvedAssumptionValue),
    exposed_value: exposedValue,
    exposed_pct: exposedPct,
  }

  // ── BLOCKED — estimate integrity failures, not uncertainty. Never
  // overridable/acknowledgeable; matches the existing non-negotiable rule
  // that a quote can't progress with unresolved/invented quantities. ──
  const blockedReasons: string[] = []
  if (unresolved_count > 0) {
    blockedReasons.push(`${unresolved_count} unresolved assumption${unresolved_count !== 1 ? 's' : ''} — quantity is undetermined, not just uncertain.`)
  }
  const unpricedCount = affectedLineItems.filter((i) => i.reason === 'unpriced').length
  if (unpricedCount > 0) {
    blockedReasons.push(`${unpricedCount} line item${unpricedCount !== 1 ? 's' : ''} could not be priced from any rate tier and would silently contribute $0.`)
  }
  if (missing_trades.length > 0) {
    blockedReasons.push(`${missing_trades.length} in-scope trade${missing_trades.length !== 1 ? 's have' : ' has'} no priced line items at all.`)
  }

  if (blockedReasons.length > 0) {
    return {
      state: 'blocked',
      blocked_reasons: blockedReasons,
      review_reasons: [],
      exposure,
      affected_line_items: affectedLineItems,
      missing_trade_ids: missing_trades,
    }
  }

  // ── REVIEW REQUIRED — known, quantified uncertainty. Acknowledgeable. ──
  const reviewReasons: string[] = []
  const confidence = overall_confidence ?? 0
  if (confidence < REVIEW_CONFIDENCE_THRESHOLD) {
    reviewReasons.push(`Overall confidence is ${confidence}%, below the ${REVIEW_CONFIDENCE_THRESHOLD}% review threshold.`)
  }
  if (exposedPct >= REVIEW_EXPOSURE_PCT_THRESHOLD) {
    reviewReasons.push(`$${exposedValue.toLocaleString('en-AU')} (${exposedPct}% of quote value) is exposed to PC/PS allowances or assumptions.`)
  }
  // NOTE: top_risks.length is a coarse trigger — it treats every entry in
  // qa_report.top_risks as equally review-worthy regardless of what actually
  // produced it (a genuinely severe missing-trade-adjacent risk reads the
  // same as a single borderline-confidence line item). A future iteration
  // should classify QA risks by severity (e.g. tag each top_risks entry with
  // a dollar value or a severity level in qa.ts) so a minor QA note can't
  // create send friction on its own — today, any non-empty top_risks list
  // trips REVIEW_REQUIRED, which is deliberately conservative rather than
  // silently permissive, but is the known simplification to revisit.
  if (top_risks.length > 0) {
    reviewReasons.push(...top_risks)
  }

  if (reviewReasons.length > 0) {
    return {
      state: 'review_required',
      blocked_reasons: [],
      review_reasons: reviewReasons,
      exposure,
      affected_line_items: affectedLineItems,
      missing_trade_ids: [],
    }
  }

  // ── READY ──
  return {
    state: 'ready',
    blocked_reasons: [],
    review_reasons: [],
    exposure,
    affected_line_items: affectedLineItems,
    missing_trade_ids: [],
  }
}
