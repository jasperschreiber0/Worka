import { intelligenceDB, allRows } from './profitability-data'
import { jobControl, jobExceptions, capacityConflicts, type ControlPlan, type ControlException } from './profit-control'
import { financialProfile, EMPTY_PROFILE, cashForecast, sumMoney, type ActualRow } from './profitability'
import { todayOperations, rankTodayExceptions } from './today'
import { projectCash, validateCashPlan } from './cash-plan'

export async function loadProfitControl(builder: string) {
  const db = intelligenceDB()
  const query = (table: string, order = 'id') => allRows(() => db.from(table).select('*').eq('builder_id', builder).order(order))
  const [jobs, settings, costs, labour, variations, candidates, plansRaw, reviews, profiles, workers, compliance, invoices, quotes, claims] = await Promise.all([
    query('jobs'), query('job_profitability_settings', 'job_id'), query('job_cost_entries'), query('job_labour_hours'),
    query('variations'), query('profitability_candidates'), query('job_control_plans', 'job_id'),
    query('profitability_reviews','job_id'), query('business_financial_profiles','builder_id'),
    allRows(() => db.from('workers').select('id,name,status').eq('builder_id',builder).order('id')),
    query('worker_compliance_records'),
    allRows(() => db.from('invoices').select('id,job_id,amount,status,due_date').eq('builder_id',builder).order('id')),
    allRows(() => db.from('quotes').select('id,job_id,status,sent_at,version').eq('builder_id',builder).order('id')),
    allRows(() => db.from('invoice_schedule').select('id,job_id,invoice_id,label').eq('builder_id',builder).order('id')),
  ])
  const plans = plansRaw as ControlPlan[], profile = profiles[0] ?? null
  const business = profile ? financialProfile({ ...EMPTY_PROFILE,...profile.profile }) : null
  const exceptions: ControlException[] = []
  if (!business?.viable) exceptions.push({id:'business:profile',priority:2,title:'Set your sustainable business margin',detail:'Record annual revenue, overhead and your profit target to enable the business margin check.',href:'/business',action:'Complete the financial profile'})
  if (profile?.cash_flow?.weeks?.length !== 13) exceptions.push({id:'cash:missing',priority:2,title:'Build your 13-week cash forecast',detail:'Opening cash and dated expected receipts and payments have not been recorded.',href:'/business',action:'Enter the cash plan'})
  const rows = jobs.map(job => {
    const s = settings.find(s => s.job_id === job.id)
    const hours = labour.filter(l => l.job_id === job.id)
    const actuals: ActualRow[] = [...costs.filter(c => c.job_id === job.id), ...(s?.settings?.labourIncluded === true ? [] : hours.filter(l=>l.hourly_rate !== null).map(l => ({
      id:l.id, trade_category_id:l.trade_category_id, description:l.note || 'Site labour', amount:Number(l.hours)*Number(l.hourly_rate),
    })))]
    const plan = plans.find(p => p.job_id === job.id) ?? null
    const control = jobControl({revision:job.profitability_revision, contract:s?.original_contract == null ? null : Number(s.original_contract),
      baseline:s?.baseline_items ?? [], actuals, approvedVariations:sumMoney(variations.filter(v=>v.job_id===job.id && v.status==='approved').map(v=>Number(v.amount))),
      uncostedHours:s?.settings?.labourIncluded === true ? 0 : sumMoney(hours.filter(l=>l.hourly_rate===null).map(l=>Number(l.hours))),
      taxReconciled:s?.settings?.taxReconciled===true,plan,candidates:candidates.filter(c=>c.job_id===job.id)})
    const live = !['completed','archived','cancelled'].includes(job.status)
    if (live) exceptions.push(...jobExceptions(job,control,business?.targetMargin ?? null))
    return { id:job.id,address:job.address,status:job.status,revision:job.profitability_revision,control,plan,
      learned:reviews.some(r=>r.job_id===job.id && r.evidence?.taxReconciled===true && r.evidence?.mappingsConfirmed===true), live }
  })
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date())
  const operations = todayOperations(jobs, invoices, variations, today, quotes, claims)
  const conflicts = capacityConflicts(plans.filter(p => rows.some(j=>j.id===p.job_id && j.live) && p.finish_on && p.finish_on >= today))
  for (const c of conflicts) exceptions.push({id:`capacity:${c.jobIds.join(':')}`,priority:2,title:'Supervisor booking overlaps',
    detail:`${workers.find(w=>w.id===c.workerId)?.name ?? 'Assigned worker'} is assigned to ${c.jobIds.map(id=>rows.find(j=>j.id===id)?.address).join(' and ')}.`,href:'/business',action:'Review planned dates and supervisor'})
  const expiryLimit = new Date(Date.now()+30*86400000).toISOString().slice(0,10)
  for (const c of compliance) if (!c.expires_on || c.expires_on <= expiryLimit) exceptions.push({id:`compliance:${c.id}`,priority:c.expires_on && c.expires_on < today ? 1 : 2,
    title:`${workers.find(w=>w.id===c.worker_id)?.name ?? 'Subcontractor'}: ${c.kind} review`,detail:c.expires_on ? `Recorded expiry ${c.expires_on}. Check the current evidence before booking work.` : 'No expiry recorded. Verify the document and record its currency.',href:'/business',action:'Review subcontractor evidence'})
  let cash = null
  if (profile?.cash_flow?.weeks?.length===13) {
    cash = {...cashForecast(profile.cash_flow.opening,profile.cash_flow.weeks),complete:profile.cash_flow.complete===true,
      startOn:profile.cash_flow.startOn ?? null, updatedAt:profile.updated_at}
    if (cash.deficitWeeks) exceptions.push({id:'cash:deficit',priority:1,title:'Cash forecast has a shortfall',detail:`Lowest projected closing cash is $${cash.lowest.toLocaleString('en-AU')} in week ${cash.lowestWeek}.`,href:'/business',action:'Review receipts, payments and timing'})
    if (!cash.complete || !cash.startOn || cash.startOn < today) exceptions.push({id:'cash:review',priority:2,title:'Refresh the 13-week cash forecast',detail:'Confirm dated receipts, wages, overhead and supplier payments. The forecast is a manual plan, not a bank balance.',href:'/business',action:'Update the cash plan'})
    if(profile.cash_flow.plan){
      const plan=validateCashPlan(profile.cash_flow.plan), projection=projectCash(plan)
      if(projection.headroom<0) exceptions.push({id:'cash:buffer',priority:1,title:'Cash falls below your chosen buffer',detail:`Projected low $${projection.lowest.toLocaleString('en-AU')} on ${projection.lowestOn}, $${Math.abs(projection.headroom).toLocaleString('en-AU')} below your buffer.${projection.weeklyTiming?' Weekly allowances leave daily timing uncertain.':''}`,href:'/business#cash-flow',action:'Review payment timing'})
    }
  }
  const active=rows.filter(j=>j.live), covered=active.filter(j=>j.control.complete)
  const learnedReviews=reviews.filter(r=>r.evidence?.taxReconciled===true && r.evidence?.mappingsConfirmed===true)
  const latest = await allRows(() => db.from('jobs').select('id,profitability_revision').eq('builder_id',builder).order('id'))
  if (latest.length !== jobs.length || latest.some(j => !jobs.some(old => old.id === j.id && Number(old.profitability_revision) === Number(j.profitability_revision))))
    throw new Error('Financial records changed while loading; refresh to review the latest figures')
  return {jobs:rows,workers,compliance,conflicts,business,cash,operations,
    totals:{active:active.length,confirmed:covered.length,forecastProfit:covered.length ? sumMoney(covered.map(j=>j.control.profit!)) : null,
      contractRevenue:covered.length ? sumMoney(covered.map(j=>j.control.revenue!)) : null,
      leakage:covered.length ? sumMoney(covered.map(j=>j.control.leakage ?? 0)) : null,
      unbilled:sumMoney(active.map(j=>j.control.unbilled))},
    memory:learnedReviews.map(r=>({jobId:r.job_id,address:rows.find(j=>j.id===r.job_id)?.address ?? 'Completed job',confirmedAt:r.confirmed_at,
      context:r.context,trades:r.review.trades,expectedMargin:r.review.expectedMargin,actualMargin:r.review.actualMargin})),
    exceptions:rankTodayExceptions([...exceptions.map(e => ({...e,
      href:e.id.startsWith('cash:')?'/business#cash-flow':e.id==='business:profile'?'/business#financial-profile':e.href,
      impact:e.id.endsWith(':leakage') ? rows.find(j=>e.id===`${j.id}:leakage`)?.control.leakage ?? undefined : e.id==='cash:deficit' && cash ? Math.abs(cash.lowest) : undefined})), ...operations.exceptions]),
    generatedAt:new Date().toISOString(),demo:false}
}
