// Pure deterministic arithmetic. Percentages are percentage points, money is ex GST.
// Match PostgreSQL numeric rounding, including half-cent credits (away from zero).
export const roundMoney = (n: number) => {
  const scaled=Math.abs(n)*100, cents=Math.round(scaled+Number.EPSILON*scaled)
  return cents===0?0:Math.sign(n)*cents/100
}
export const sumMoney = (values: number[]) => roundMoney(values.reduce((a, b) => a + b, 0))
export function amount(n: unknown, label = 'Amount', min = 0): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || Math.abs(n) > 999999999)
    throw new Error(`${label} must be a valid number${min === 0 ? ' of zero or more' : ''}`)
  return roundMoney(n)
}
export function percent(n: unknown, label = 'Percentage'): number {
  const value = amount(n, label)
  if (value >= 100) throw new Error(`${label} must be below 100%`)
  return value
}
export const OVERHEAD_FIELDS = [
  'Office/admin wages',
  'Rent',
  'Vehicles',
  'Insurance',
  'Software',
  'Accounting',
  'Marketing',
  'Finance',
  'Licences',
  'Professional services',
  'Other',
] as const
export interface FinancialProfile {
  annualRevenue: number
  targetRevenue: number
  overheadMode: 'simple' | 'detailed'
  annualOverhead: number
  overheads: Record<string, number>
  profitMode: 'percent' | 'amount'
  netProfitPct: number
  annualProfit: number
  workingWeeks: number
  jobsPerYear: number | null
  constructionVolume: number | null
}
export const EMPTY_PROFILE: FinancialProfile = {
  annualRevenue: 0,
  targetRevenue: 0,
  overheadMode: 'simple',
  annualOverhead: 0,
  overheads: {},
  profitMode: 'percent',
  netProfitPct: 0,
  annualProfit: 0,
  workingWeeks: 48,
  jobsPerYear: null,
  constructionVolume: null,
}
export function financialProfile(p: FinancialProfile) {
  amount(p.annualRevenue)
  amount(p.targetRevenue)
  amount(p.annualOverhead)
  amount(p.annualProfit)
  percent(p.netProfitPct)
  if (
    !['simple', 'detailed'].includes(p.overheadMode) ||
    !['percent', 'amount'].includes(p.profitMode)
  )
    throw new Error('Choose an overhead and profit basis')
  if (!Number.isFinite(p.workingWeeks) || p.workingWeeks <= 0 || p.workingWeeks > 52)
    throw new Error('Working weeks must be between 1 and 52')
  if (p.jobsPerYear !== null) amount(p.jobsPerYear, 'Jobs per year')
  if (p.constructionVolume !== null) amount(p.constructionVolume, 'Construction volume')
  const overhead =
    p.overheadMode === 'detailed'
      ? sumMoney(OVERHEAD_FIELDS.map((k) => amount(p.overheads[k] ?? 0, k)))
      : p.annualOverhead
  const revenue = p.targetRevenue || p.annualRevenue
  const targetProfit =
    p.profitMode === 'amount' ? p.annualProfit : roundMoney((revenue * p.netProfitPct) / 100)
  const minimumMargin = revenue > 0 ? (overhead / revenue) * 100 : null
  const targetMargin = revenue > 0 ? ((overhead + targetProfit) / revenue) * 100 : null
  return {
    overhead,
    monthlyOverhead: roundMoney(overhead / 12),
    weeklyOverhead: roundMoney(overhead / p.workingWeeks),
    revenue,
    targetProfit,
    minimumMargin,
    targetMargin,
    overheadPctOfActualRevenue: p.annualRevenue > 0 ? (overhead / p.annualRevenue) * 100 : null,
    breakEvenRevenue:
      targetMargin !== null && targetMargin > 0 && targetMargin < 100
        ? roundMoney(overhead / (targetMargin / 100))
        : null,
    viable: targetMargin !== null && targetMargin < 100,
  }
}
export function marginGate(
  cost: number,
  price: number,
  minimum: number,
  target: number,
  contingency = 0,
) {
  amount(cost)
  amount(price)
  percent(minimum)
  percent(target)
  percent(contingency)
  if (target < minimum) throw new Error('Target margin must cover the minimum sustainable margin')
  const adjustedCost = roundMoney(cost * (1 + contingency / 100))
  const profit = roundMoney(price - adjustedCost)
  const margin = price > 0 ? (profit / price) * 100 : null
  const overhead = roundMoney((price * minimum) / 100)
  const recommendedPrice = roundMoney(adjustedCost / (1 - target / 100))
  return {
    cost: adjustedCost,
    price,
    profit,
    margin,
    markup: adjustedCost > 0 ? (profit / adjustedCost) * 100 : null,
    overhead,
    contribution: profit,
    netProfit: roundMoney(profit - overhead),
    recommendedPrice,
    minimumPrice: roundMoney(adjustedCost / (1 - minimum / 100)),
    shortfall: roundMoney(Math.max(0, recommendedPrice - price)),
    buffer: margin === null ? null : margin - minimum,
    status:
      price > 0 && price >= recommendedPrice
        ? 'HEALTHY'
        : margin !== null && margin >= minimum
          ? 'TIGHT'
          : 'BELOW TARGET',
  }
}
export interface EstimateRow {
  id: string
  trade_category_id: number | null
  description: string
  total: number | null
  margin_pct: number | null
  assumption_status?: string | null
  variation_id?: string | null
  labour_cost?: number | null
}
export interface ActualRow {
  id: string
  trade_category_id: number | null
  description: string
  amount: number
  cost_kind?: string
  incurred_on?: string
  supplier?: string | null
  invoice_ref?: string | null
  labour_hours?: number | null
  labour_cost?: number | null
  category?: string | null
  source_ref?: string | null
  variation_id?: string | null
}
export interface Candidate {
  id: string
  title: string
  trade_category_id: number | null
  estimated_cost: number | null
  proposed_charge: number | null
  status: string
  recovered: number
  incurred: number
  billed: number
  evidence: string
  variation_id?: string | null
  original_scope?: string | null
  confidence?: number | null
}
export function riskSummary(rows: Candidate[]) {
  const open = rows.filter((r) => !['recovered', 'not_a_change'].includes(r.status))
  return {
    atRisk: sumMoney(open.map((r) => Math.max(0, (r.estimated_cost ?? r.incurred) - r.recovered))),
    unknown: open.filter((r) => r.estimated_cost === null).length,
    unapproved: rows.filter((r) => ['potential', 'reviewing', 'priced', 'sent'].includes(r.status))
      .length,
    unrecovered: sumMoney(rows.map((r) => Math.max(0, r.incurred - r.recovered))),
    unbilled: sumMoney(rows.map((r) => Math.max(0, r.incurred - r.billed))),
    recoveryRate:
      sumMoney(rows.map((r) => r.incurred)) > 0
        ? (sumMoney(rows.map((r) => r.recovered)) / sumMoney(rows.map((r) => r.incurred))) * 100
        : null,
  }
}
export function profitabilityReview(
  estimate: EstimateRow[],
  actuals: ActualRow[],
  originalContract: number,
  approvedVariations: number,
  complete: boolean,
  estimatedHours: Record<string, number> = {},
) {
  amount(originalContract)
  amount(approvedVariations, 'Approved variations', -999999999)
  const baseline = estimate.filter((r) => r.assumption_status !== 'excluded' && !r.variation_id)
  const incurred = actuals.filter((r) => !r.cost_kind || r.cost_kind === 'incurred')
  const estimatedCost = sumMoney(baseline.map((r) => r.total ?? 0)),
    actualCost = sumMoney(incurred.map((r) => Number(r.amount)))
  const revenue = roundMoney(originalContract + approvedVariations),
    expectedProfit = roundMoney(originalContract - estimatedCost),
    actualProfit = roundMoney(revenue - actualCost)
  const expectedMargin = originalContract > 0 ? (expectedProfit / originalContract) * 100 : null,
    actualMargin = revenue > 0 ? (actualProfit / revenue) * 100 : null
  const ids = Array.from(new Set([...baseline, ...incurred].map((r) => r.trade_category_id)))
  const trades = ids
    .map((id) => {
      const e = baseline.filter((r) => r.trade_category_id === id),
        a = incurred.filter((r) => r.trade_category_id === id)
      const estimated = sumMoney(e.map((r) => r.total ?? 0)),
        actual = sumMoney(a.map((r) => Number(r.amount))),
        variance = roundMoney(actual - estimated)
      const hours = sumMoney(a.map((r) => r.labour_hours ?? 0)),
        plannedHours = estimatedHours[String(id)] ?? null
      if (plannedHours !== null) amount(plannedHours, 'Estimated labour hours')
      return {
        id,
        estimated,
        actual,
        variance,
        variancePct: estimated > 0 ? (variance / estimated) * 100 : null,
        invoices: a,
        estimateItems: e,
        hours,
        estimatedHours: plannedHours,
        hoursVariance: plannedHours === null ? null : roundMoney(hours - plannedHours),
        estimatedLabourCost: sumMoney(e.map((r) => r.labour_cost ?? 0)),
        actualLabourCost: sumMoney(a.map((r) => r.labour_cost ?? 0)),
        marginImpact: revenue > 0 ? (-variance / revenue) * 100 : null,
      }
    })
    .sort((a, b) => b.variance - a.variance)
  const missingPrices = baseline.filter((r) => r.total === null).length
  const variance = roundMoney(actualCost - estimatedCost)
  return {
    estimatedCost,
    actualCost,
    originalContract,
    approvedVariations,
    revenue,
    expectedProfit,
    actualProfit,
    expectedMargin,
    actualMargin,
    marginMovement:
      expectedMargin === null || actualMargin === null ? null : actualMargin - expectedMargin,
    variance,
    variancePct: estimatedCost > 0 ? (variance / estimatedCost) * 100 : null,
    trades,
    missingPrices,
    complete: complete && missingPrices === 0 && baseline.length > 0,
    // Exactly reconciles: variance costs already include unrecovered change costs. Never subtract those twice.
    waterfall: [
      { label: 'Expected profit', amount: expectedProfit },
      { label: 'Approved variation revenue', amount: approvedVariations },
      ...trades.map((t) => ({
        label: t.id === null ? 'Unclassified costs' : `Trade ${t.id}`,
        amount: -t.variance,
      })),
      { label: 'Actual profit', amount: actualProfit },
    ],
  }
}
export function waterfallLayout(steps: { label: string; amount: number }[]) {
  let balance = 0
  const rows = steps.map((step, i) => {
    const endpoint = i === 0 || i === steps.length - 1,
      from = endpoint ? 0 : balance,
      to = endpoint ? step.amount : balance + step.amount
    balance = to
    return { ...step, endpoint, from, to }
  })
  const min = Math.min(0, ...rows.flatMap((r) => [r.from, r.to])),
    max = Math.max(0, ...rows.flatMap((r) => [r.from, r.to])),
    range = max - min || 1
  return rows.map((r) => ({
    ...r,
    left: ((Math.min(r.from, r.to) - min) / range) * 100,
    width: (Math.abs(r.to - r.from) / range) * 100,
  }))
}
export interface LearningSample {
  jobId: string
  jobType: string
  region: string
  complexity: string
  constructionType: string
  size: number | null
  trade: number
  estimated: number
  actual: number
  complete: boolean
}
export function comparableLearning(
  samples: LearningSample[],
  context: Omit<LearningSample, 'trade' | 'estimated' | 'actual' | 'complete'>,
) {
  if (
    !context.jobType ||
    !context.region ||
    !context.complexity ||
    !context.constructionType ||
    !context.size
  )
    return []
  const relevant = samples.filter(
    (s) =>
      s.complete &&
      s.jobId !== context.jobId &&
      s.jobType === context.jobType &&
      s.region === context.region &&
      s.complexity === context.complexity &&
      s.constructionType === context.constructionType &&
      s.size !== null &&
      s.size >= context.size! * 0.7 &&
      s.size <= context.size! * 1.3 &&
      s.estimated > 0,
  )
  return Array.from(new Set(relevant.map((s) => s.trade))).map((trade) => {
    const rows = Array.from(
      new Map(relevant.filter((s) => s.trade === trade).map((s) => [s.jobId, s])).values(),
    )
    const estimated = sumMoney(rows.map((r) => r.estimated)),
      actual = sumMoney(rows.map((r) => r.actual))
    return {
      trade,
      jobs: rows.map((r) => r.jobId),
      count: rows.length,
      adjustmentPct: roundMoney(((actual - estimated) / estimated) * 100),
      confidence: rows.length < 3 ? 'Low' : rows.length < 6 ? 'Moderate' : 'Higher',
    }
  })
}
export function cashForecast(opening: number, weeks: { inflow: number; outflow: number }[]) {
  amount(opening, 'Opening cash', -999999999)
  if (weeks.length !== 13) throw new Error('Enter 13 weeks')
  let balance = opening
  const rows = weeks.map((w, i) => {
    amount(w.inflow)
    amount(w.outflow)
    const start = balance
    balance = roundMoney(balance + w.inflow - w.outflow)
    return { week: i + 1, opening: start, ...w, closing: balance }
  })
  const low = rows.reduce((a, b) => (b.closing < a.closing ? b : a))
  return {
    rows,
    lowest: low.closing,
    lowestWeek: low.week,
    deficitWeeks: rows.filter((r) => r.closing < 0).length,
  }
}
