import test from 'node:test'
import assert from 'node:assert/strict'
import {projectCash,validateCashPlan,legacyCashPlan,type CashPlan,type CashEntry} from './cash-plan.ts'
const entry=(fields:Partial<CashEntry>={}):CashEntry=>({id:'one',label:'Invoice',direction:'in',amount:100,dueOn:'2026-09-21',expectedOn:'2026-09-21',frequency:'once',endOn:'',note:'',timing:'day',...fields})
const plan=(entries:CashEntry[]=[],fields:Partial<CashPlan>={}):CashPlan=>({version:1,startOn:'2026-09-21',opening:100,buffer:50,accounts:'Operating account',complete:false,entries,...fields})
test('payroll before receipt exposes daily squeeze even when weekly closing is positive',()=>{const p=projectCash(plan([entry({id:'pay',direction:'out',amount:150}),entry({expectedOn:'2026-09-25',amount:200})]));assert.equal(p.lowest,-50);assert.equal(p.weeks[0].closing,150);assert.equal(p.headroom,-100)})
test('late receipt outside horizon is omitted without modifying base',()=>{const p=plan([entry({expectedOn:'2026-12-20'})]);assert.equal(projectCash(p).weeks[12].closing,200);assert.equal(projectCash(p,{id:'one',days:14}).weeks[12].closing,100);assert.equal(p.entries[0].expectedOn,'2026-12-20')})
test('monthly repeat retains original day after short February',()=>{const p=projectCash(plan([entry({expectedOn:'2027-01-31',frequency:'monthly',endOn:'2027-04-30'})],{startOn:'2027-01-01'}));assert.deepEqual(p.daily.filter(d=>d.entries.length).map(d=>d.on),['2027-01-31','2027-02-28','2027-03-31'])})
test('weekly and fortnightly recurrence stop at inclusive end',()=>{assert.equal(projectCash(plan([entry({frequency:'weekly',endOn:'2026-10-05'})])).weeks[12].closing,400);assert.equal(projectCash(plan([entry({frequency:'fortnightly',endOn:'2026-10-05'})])).weeks[12].closing,300)})
test('opening cash already includes earlier movements; missed one-offs require review',()=>{const p=projectCash(plan([entry({expectedOn:'2026-09-20'})]));assert.equal(p.weeks[0].closing,100);assert.equal(p.overdue.length,1)})
test('cent arithmetic remains exact',()=>{const p=projectCash(plan([entry({amount:.1}),entry({id:'two',amount:.2})],{opening:0}));assert.equal(p.weeks[0].closing,.3)})
test('legacy totals retain all weeks without claiming precise daily timing',()=>{const weeks=Array.from({length:13},(_,i)=>({inflow:i*10,outflow:i*3}));const p=projectCash(legacyCashPlan({opening:3,startOn:'2026-09-21',weeks}));assert.deepEqual(p.weeks.map(({inflow,outflow})=>({inflow,outflow})),weeks);assert.equal(p.weeklyTiming,true)})
test('invalid dates, directions, duplicate IDs, negative amounts and unbounded recurrence rejected',()=>{for(const entries of [[entry({expectedOn:'2026-02-30'})],[entry({amount:-1})],[entry(),entry()],[entry({frequency:'weekly',endOn:''})],[entry({direction:'wrong' as 'in'})]])assert.throws(()=>validateCashPlan(plan(entries)));assert.throws(()=>validateCashPlan(plan([],{opening:NaN})));assert.throws(()=>validateCashPlan(plan([],{accounts:''})))})
test('lowest includes opening cash even if every subsequent balance rises',()=>{assert.equal(projectCash(plan([entry()])).lowest,100)})

import {addMonths} from './cash-plan.ts'
test('annual periods cover a leap year once and keep first 13 weeks identical',()=>{
 const p=plan([entry({expectedOn:'2024-01-31',frequency:'monthly',endOn:'2025-01-30'}),entry({id:'last',expectedOn:'2025-01-30',amount:.25}),entry({id:'outside',expectedOn:'2025-01-31',amount:999})],{startOn:'2024-01-31',opening:0})
 const a=projectCash(p,undefined,'12-months');assert.equal(a.daily.length,366);assert.equal(a.months.length,12);assert.equal(a.months.at(-1)!.closing,1200.25);assert.equal(a.months[0].endOn,'2024-02-28');assert.equal(a.months[1].startOn,'2024-02-29');assert.equal(addMonths('2024-01-31',2),'2024-03-31');assert.deepEqual(a.weeks,projectCash(p).weeks)
 assert.equal(a.months.reduce((s,m)=>s+m.inflow,0),1200.25)
})
test('annual late-payment scenario crosses the boundary without changing saved entries',()=>{const p=plan([entry({expectedOn:'2027-09-20'})]);assert.equal(projectCash(p,undefined,'12-months').months[11].closing,200);assert.equal(projectCash(p,{id:'one',days:14},'12-months').months[11].closing,100);assert.equal(p.entries[0].expectedOn,'2027-09-20')})
