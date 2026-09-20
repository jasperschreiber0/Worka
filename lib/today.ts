import { sumMoney } from './profitability.ts'
import { isOpenJob } from './job-status.ts'
import type { ControlException } from './profit-control.ts'

export type TodayException = ControlException & { impact?: number; dueOn?: string }
type Job = { id: string; address: string; status: string }
type Invoice = { id: string; job_id: string; amount: number; status: string; due_date: string | null }
type Variation = { id: string; job_id: string; amount: number; status: string }
type Quote = { job_id: string; status: string; sent_at: string | null; version: number }
type Claim = { job_id: string; invoice_id: string | null; label: string }

// No cross-currency, contract-value or unsigned-variation amounts are treated as profit.
export function todayOperations(jobs: Job[], invoices: Invoice[], variations: Variation[], today: string, quotes: Quote[] = [], claims: Claim[] = []) {
  const owned = new Map(jobs.map(j => [j.id, j]))
  const overdue = invoices.filter(i => owned.has(i.job_id) && ['sent', 'overdue'].includes(i.status) && i.due_date && i.due_date < today)
  const pending = variations.filter(v => owned.has(v.job_id) && v.status === 'pending')
  const exceptions: TodayException[] = []
  for (const job of jobs) {
    const bills = overdue.filter(i => i.job_id === job.id)
    const changes = pending.filter(v => v.job_id === job.id)
    const due = invoices.filter(i=>i.job_id===job.id && ['sent','overdue'].includes(i.status) && i.due_date===today)
    const quote = quotes.filter(q=>q.job_id===job.id).sort((a,b)=>b.version-a.version)[0]
    const unclaimed = claims.filter(c=>c.job_id===job.id && !c.invoice_id)
    if (bills.length) exceptions.push({ id: `${job.id}:invoices`, priority: 1,
      title: `${job.address}: overdue invoices`, detail: `${bills.length} issued invoice${bills.length === 1 ? '' : 's'} overdue. Review payment records before following up.`,
      impact: sumMoney(bills.map(i => Number(i.amount))), dueOn: bills.map(i => i.due_date!).sort()[0],
      href: `/jobs/${job.id}?section=money`, action: 'Review job invoices' })
    if (changes.length) exceptions.push({ id: `${job.id}:variations`, priority: 2,
      title: `${job.address}: variations awaiting approval`, detail: `${changes.length} variation${changes.length === 1 ? '' : 's'} pending. Proposed charges are not approved revenue or confirmed losses.`,
      href: `/jobs/${job.id}?section=money`, action: 'Review job variations' })
    if (due.length) exceptions.push({id:`${job.id}:due-today`,priority:2,title:`${job.address}: invoices due today`,
      detail:`${due.length} issued invoice${due.length===1?'':'s'} due today. Check receipts before following up.`,dueOn:today,
      impact:sumMoney(due.map(i=>Number(i.amount))),href:`/jobs/${job.id}?section=money`,action:'Review job invoices'})
    if (isOpenJob(job.status) && quote?.status==='sent' && quote.sent_at) exceptions.push({id:`${job.id}:quote`,priority:2,
      title:`${job.address}: quote awaiting response`,detail:`Latest quote was sent ${new Date(quote.sent_at).toLocaleDateString('en-AU',{timeZone:'Australia/Sydney'})}. Review its status before following up.`,
      href:`/jobs/${job.id}`,action:'Review quote'})
    if (job.status==='active' && unclaimed.length) exceptions.push({id:`${job.id}:claims`,priority:2,
      title:`${job.address}: scheduled claims to review`,detail:`${unclaimed.length} scheduled stage${unclaimed.length===1?' has':'s have'} no linked invoice. Check stage completion and entitlement before invoicing.`,
      href:`/jobs/${job.id}?section=money`,action:'Review claim schedule'})
  }
  return { activeJobs: jobs.filter(j => j.status === 'active').length, overdueCount: overdue.length,
    overdueTotal: sumMoney(overdue.map(i => Number(i.amount))), pendingCount: pending.length, exceptions }
}

export function rankTodayExceptions(rows: TodayException[]): TodayException[] {
  const unique = new Map(rows.map(row => [row.id, {...row}]))
  for (const row of Array.from(unique.values())) {
    if (!row.id.endsWith(':margin')) continue
    const leakage = unique.get(row.id.replace(/:margin$/, ':leakage'))
    if (leakage) { leakage.detail += ` ${row.detail}`; unique.delete(row.id) }
  }
  return Array.from(unique.values()).sort((a, b) =>
    a.priority - b.priority || (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') ||
    (b.impact ?? -1) - (a.impact ?? -1) || a.id.localeCompare(b.id))
}

export function targetMarkup(targetMargin: number | null): number | null {
  return targetMargin !== null && Number.isFinite(targetMargin) && targetMargin >= 0 && targetMargin < 100
    ? targetMargin / (100 - targetMargin) * 100 : null
}
