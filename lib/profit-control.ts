import { calculateJobProfit } from './job-profit.ts'
import { roundMoney, sumMoney, type EstimateRow, type ActualRow, type Candidate } from './profitability.ts'

export interface ControlPlan {
  job_id: string
  confirmed_revision: number | null
  confirmed_at: string | null
  cash_received: number | null
  cash_paid: number | null
  cash_as_of: string | null
  start_on: string | null
  finish_on: string | null
  lead_worker_id: string | null
}
export function jobControl(input: {
  revision: number; contract: number | null; baseline: EstimateRow[]
  actuals: ActualRow[]; approvedVariations: number; uncostedHours: number
  taxReconciled: boolean; plan: ControlPlan | null; candidates: Candidate[]
}) {
  const actual = sumMoney(input.actuals.filter(r => !r.cost_kind || r.cost_kind === 'incurred').map(r => Number(r.amount)))
  const commitments = sumMoney(input.actuals.filter(r => r.cost_kind === 'committed').map(r => Number(r.amount)))
  const remaining = sumMoney(input.actuals.filter(r => r.cost_kind === 'remaining').map(r => Number(r.amount)))
  const baseline = input.baseline.filter(r => r.assumption_status !== 'excluded' && !r.variation_id)
  const baselineComplete = baseline.length > 0 && baseline.every(r => r.total !== null)
  const confirmed = input.plan?.confirmed_revision != null && Number(input.plan.confirmed_revision) === Number(input.revision)
  const forecast = calculateJobProfit({ contract: input.contract, approvedVariations: input.approvedVariations,
    actual, outstandingCommitments: commitments, remaining: confirmed ? remaining : null,
    uncostedHours: input.uncostedHours, reconciled: confirmed && input.taxReconciled && baselineComplete })
  const estimatedCost = baselineComplete ? sumMoney(baseline.map(r => Number(r.total))) : null
  const quotedProfit = input.contract !== null && estimatedCost !== null ? roundMoney(input.contract - estimatedCost) : null
  const quotedMargin = quotedProfit !== null && input.contract !== null && input.contract > 0 ? quotedProfit / input.contract * 100 : null
  // Variation revenue is already in forecast.profit; scope costs are already in the cost ledger.
  const leakage = forecast.profit !== null && quotedProfit !== null ? roundMoney(Math.max(0, quotedProfit - forecast.profit)) : null
  const unbilled = sumMoney(input.candidates.filter(c => c.status !== 'not_a_change').map(c => Math.max(0, Number(c.incurred) - Number(c.billed))))
  const cash = input.plan?.cash_received != null && input.plan.cash_paid != null && input.plan.cash_as_of
    ? roundMoney(input.plan.cash_received - input.plan.cash_paid) : null
  return { ...forecast, actual, commitments, remaining, costToComplete: confirmed ? sumMoney([commitments, remaining]) : null,
    quotedMargin, quotedProfit, estimatedCost, leakage, unbilled, cash, cashAsOf: input.plan?.cash_as_of ?? null,
    confirmed, baselineComplete, taxReconciled: input.taxReconciled }
}

export function dateOnly(value: unknown, label: string): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value)
    throw new Error(`${label} must be a valid date`)
  return value
}

export function capacityConflicts(plans: ControlPlan[]) {
  const booked = plans.filter(p => p.lead_worker_id && p.start_on && p.finish_on)
  const conflicts: { workerId: string; jobIds: string[]; start: string; finish: string }[] = []
  for (let i = 0; i < booked.length; i++) for (let j = i + 1; j < booked.length; j++) {
    const a = booked[i], b = booked[j]
    if (a.lead_worker_id !== b.lead_worker_id) continue
    const start = a.start_on! > b.start_on! ? a.start_on! : b.start_on!
    const finish = a.finish_on! < b.finish_on! ? a.finish_on! : b.finish_on!
    if (start <= finish) conflicts.push({ workerId: a.lead_worker_id!, jobIds: [a.job_id,b.job_id], start, finish })
  }
  return conflicts
}

export interface ControlException { id: string; priority: number; title: string; detail: string; href: string; action: string }
export function jobExceptions(job: { id: string; address: string }, control: ReturnType<typeof jobControl>, target: number | null): ControlException[] {
  const href = `/jobs/${job.id}/profitability`, rows: ControlException[] = []
  if (!control.complete) rows.push({ id: `${job.id}:incomplete`, priority: 3, title: `${job.address}: forecast needs review`,
    detail: [...control.reasons, ...(!control.taxReconciled ? ['Confirm GST basis in Financial gate'] : []),
      ...(!control.baselineComplete ? ['Capture the original priced estimate'] : [])].join('. '), href, action: 'Review costs to finish' })
  if (control.leakage !== null && control.leakage > 0) rows.push({ id: `${job.id}:leakage`, priority: 1,
    title: `${job.address}: margin leakage`, detail: `$${control.leakage.toLocaleString('en-AU')} less gross profit than the original estimate.`, href, action: 'Review trade variances and scope changes' })
  if (target !== null && control.margin !== null && control.margin < target) rows.push({ id: `${job.id}:margin`, priority: 1,
    title: `${job.address}: below required margin`, detail: `Forecast ${control.margin.toFixed(1)}%; business target ${target.toFixed(1)}%.`, href, action: 'Review remaining costs and variation recovery' })
  if (control.unbilled > 0) rows.push({ id: `${job.id}:unbilled`, priority: 2, title: `${job.address}: unbilled change costs`,
    detail: `$${control.unbilled.toLocaleString('en-AU')} of recorded change costs remain unbilled. Check entitlement and approval before invoicing.`, href, action: 'Review scope and variations' })
  return rows
}
