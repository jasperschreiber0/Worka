import test from 'node:test'
import assert from 'node:assert/strict'
import {newWorkspace,parseWorkspace} from './studio-workspace.ts'
import {rectangleGeometry} from './studio-geometry.ts'
import {prepareLinkedTakeoff} from './studio-draft-takeoff.ts'
import {totals,revise,financials} from './project-studio.ts'
import {omitWallProposal} from './studio-meeting.ts'
const project=()=>{const w=newWorkspace();w.project.working.design={width:8,depth:6,height:2.7,geometry:rectangleGeometry(8,6,2.7)};return w}
test('alteration candidates stay outside the price and repeated preparation does not duplicate items',()=>{
 const w=project(),r=prepareLinkedTakeoff(w,false);assert.equal(r.added,16);assert.ok(r.workspace.project.working.lines.every(l=>!l.included&&!l.quantityVerified&&!l.rateVerified));assert.equal(totals(r.workspace.project.working).total,0);assert.equal(prepareLinkedTakeoff(r.workspace,false).added,0);assert.ok(parseWorkspace(r.workspace));assert.equal(w.project.working.lines.length,0)
})
test('linked cost, price and forecast respond to wall omission while accepted scope stays unchanged',()=>{
 let w=prepareLinkedTakeoff(project(),true).workspace
 w.project=revise(w.project,{lines:w.project.working.lines.map(l=>({...l,rate:10}))})
 const before=totals(w.project.working),next=omitWallProposal(w,'wall-0',0),after=totals(next.project.working)
 assert.ok(after.cost<before.cost);assert.equal(financials(next.project).forecast,after.cost);assert.ok(parseWorkspace(next))
 w.project.baseline=structuredClone(w.project.working);const baseline=JSON.stringify(w.project.baseline)
 assert.equal(JSON.stringify(omitWallProposal(w,'wall-0',0).project.baseline),baseline)
})
test('rates require exact package identity and unit; conflicting quotes cannot be silently chosen',()=>{
 const w=project(),template=prepareLinkedTakeoff(w,true).workspace.project.working.lines[0]
 w.rates=[{...template,id:'rate',rate:25,rateVerified:true}]
 const r=prepareLinkedTakeoff(w,true);assert.equal(r.reusedRates,4);assert.equal(r.workspace.project.working.lines[0].rate,25);assert.equal(r.workspace.project.working.lines[0].rateVerified,false)
 w.rates.push({...w.rates[0],id:'other',rate:30});assert.equal(prepareLinkedTakeoff(w,true).reusedRates,0)
})
