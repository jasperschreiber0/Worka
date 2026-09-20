import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jobControl, jobExceptions, capacityConflicts, dateOnly, type ControlPlan } from './profit-control.ts'
const plan:ControlPlan={job_id:'one',confirmed_revision:7,confirmed_at:'2026-09-20',cash_received:50000,cash_paid:30000,cash_as_of:'2026-09-20',start_on:'2026-10-01',finish_on:'2026-10-31',lead_worker_id:'worker'}
const input={revision:7,contract:100000,baseline:[{id:'base',trade_category_id:2,description:'Framing',total:70000,margin_pct:0.3}],
  actuals:[{id:'actual',trade_category_id:2,description:'Paid invoice',amount:50000,cost_kind:'incurred'},
    {id:'commit',trade_category_id:2,description:'Outstanding order balance',amount:25000,cost_kind:'committed'},
    {id:'remain',trade_category_id:2,description:'Other work',amount:10000,cost_kind:'remaining'}],
  approvedVariations:5000,uncostedHours:0,taxReconciled:true,plan,candidates:[]}
test('forecast keeps incurred, outstanding and remaining costs separate and counts variation revenue once',()=>{
 const c=jobControl(input);assert.equal(c.forecastCost,85000);assert.equal(c.costToComplete,35000);assert.equal(c.profit,20000);assert.equal(c.leakage,10000);assert.equal(c.cash,20000);assert.equal(c.quotedMargin,30)
})
test('new costs invalidate confirmation; partial actuals never masquerade as final profit',()=>{
 const c=jobControl({...input,revision:8});assert.equal(c.profit,null);assert.equal(c.margin,null);assert.equal(c.costToComplete,null);assert.equal(c.actual,50000)
})
test('missing baseline, GST basis or uncosted labour prevents a published forecast',()=>{
 for(const change of [{baseline:[]},{taxReconciled:false},{uncostedHours:2},{contract:null},{plan:null}])assert.equal(jobControl({...input,...change}).complete,false)
})
test('zero remaining cost is valid only when explicitly confirmed; losses are retained',()=>{
 const c=jobControl({...input,actuals:[{...input.actuals[0],amount:120000}]});assert.equal(c.costToComplete,0);assert.equal(c.profit,-15000);assert.equal(c.leakage,45000)
})
test('tracking costs do not double count ledger costs; non-changes do not create unbilled exposure',()=>{
 const candidate={id:'c',title:'Change',trade_category_id:2,estimated_cost:1000,proposed_charge:2000,status:'potential',incurred:1000,billed:200,recovered:0,evidence:'Site instruction'}
 const c=jobControl({...input,candidates:[candidate,{...candidate,id:'not',status:'not_a_change'}]});assert.equal(c.unbilled,800);assert.equal(c.forecastCost,85000)
 const e=jobExceptions({id:'job',address:'Example'},c,25);assert.equal(e.length,3);assert.ok(e.every(r=>r.href==='/jobs/job/profitability'))
})
test('capacity overlap includes shared dates and excludes unrelated workers and incomplete plans',()=>{
 assert.equal(capacityConflicts([plan,{...plan,job_id:'two',start_on:'2026-10-31'}]).length,1)
 assert.equal(capacityConflicts([plan,{...plan,job_id:'two',start_on:'2026-11-01',finish_on:'2026-11-03'}]).length,0)
 assert.equal(capacityConflicts([plan,{...plan,job_id:'two',lead_worker_id:'other'}]).length,0)
})
test('invalid or rolled-over dates are rejected',()=>{
 assert.equal(dateOnly('2028-02-29','Date'),'2028-02-29');assert.equal(dateOnly('','Date'),null)
 for(const v of ['2026-02-29','2026-13-01','not a date',42])assert.throws(()=>dateOnly(v,'Date'))
})
