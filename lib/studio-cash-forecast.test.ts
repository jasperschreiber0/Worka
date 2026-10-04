import test from 'node:test'
import assert from 'node:assert/strict'
import {newWorkspace,parseWorkspace} from './studio-workspace.ts'
import {defaultProjectTiming,projectCashForecast} from './studio-cash-forecast.ts'
import {totals,revise} from './project-studio.ts'
const workspace=()=>{const w=newWorkspace();w.project.working.lines=[{id:'test',name:'Test only',trade:'Structure',unit:'item',source:'entered',quantity:1,rate:12345.67,included:true,allowance:true,note:'Synthetic rate',rateVerified:false}];return w}
test('both cash horizons reconcile to priced scope including selected GST without recording bank movements',()=>{
 const w=workspace(),t={...defaultProjectTiming('2026-10-01'),costGstPercent:10};w.cashTiming=t
 const before=JSON.stringify(w),r=projectCashForecast(w,t,'proposed'),price=totals(w.project.working)
 assert.equal(r.receipts,price.total);assert.equal(r.payments,Math.round(price.cost*110)/100)
 assert.equal(Math.round(r.months.months.reduce((s,m)=>s+m.inflow,0)*100),Math.round(price.total*100))
 assert.equal(Math.round(r.months.months.reduce((s,m)=>s+m.outflow,0)*100),Math.round(r.payments*100))
 assert.equal(r.weeks.weeks.length,13);assert.equal(r.months.months.length,12);assert.equal(r.plan.complete,false);assert.equal(JSON.stringify(w),before);assert.ok(parseWorkspace(w))
})
test('proposed changes update scenario cash while accepted contract remains unchanged',()=>{
 const w=workspace(),t={...defaultProjectTiming('2026-10-01'),costGstPercent:0};w.project.baseline=structuredClone(w.project.working)
 const accepted=projectCashForecast(w,t,'accepted');w.project=revise(w.project,{lines:w.project.working.lines.map(l=>({...l,rate:10000}))})
 assert.deepEqual(projectCashForecast(w,t,'accepted'),accepted);assert.ok(projectCashForecast(w,t,'proposed').payments<accepted.payments)
})
test('missing GST assumptions and invalid dates cannot become a saved forecast',()=>{
 const w=workspace(),t=defaultProjectTiming('2026-10-01');assert.throws(()=>projectCashForecast(w,t,'proposed'))
 w.cashTiming={...t,startOn:'2026-02-31'};assert.equal(parseWorkspace(w),null)
 assert.throws(()=>projectCashForecast(w,{...t,costGstPercent:10},'accepted'))
})
