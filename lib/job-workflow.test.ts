import test from 'node:test'
import assert from 'node:assert/strict'
import { tileScenario, exGST, validateWorkflow, programmeReadiness } from './job-workflow.ts'
import {roundMoney} from './profitability.ts'
const input={room:'Bathroom',area:20,original_rate:80,original_gst:'exclusive',proposed_rate:300,proposed_gst:'exclusive',price_basis:'purchase_cost',installation:'supply_only',wastage_pct:0,extras:0,markup_pct:20,reviewed:true}
test('tile change uses signed deterministic costs, GST and distinct charge/absorption outcomes',()=>{
 const result=tileScenario(input,{revenue:100000,cost:75000})
 assert.equal(result.supply_delta,4400);assert.equal(result.proposed_charge,5280);assert.equal(result.gst,528)
 assert.equal(result.absorbed_profit,20600);assert.equal(result.charged_profit,25880);assert.equal(result.absorbed_margin,20.6)
 assert.match(result.email_draft,/5,808/)
})
test('unknown adjustments remain unknown and cannot become an approved variation',()=>{
 const r=tileScenario({...input,extras:null});assert.equal(r.expected_cost,null);assert.equal(r.ready,false)
 assert.throws(()=>tileScenario({...input,price_basis:'client_allowance'}),/purchase costs/)
 assert.throws(()=>tileScenario({...input,extras:100,extra_evidence:''}),/evidence/)
 assert.throws(()=>tileScenario({...input,installation:''}),/installation/)
})
test('inclusive source rates and lower selections preserve direction',()=>{
 assert.equal(tileScenario({...input,original_rate:330,proposed_rate:88,original_gst:'inclusive',proposed_gst:'inclusive'}).supply_delta,-4400)
 assert.equal(exGST(-1100,'inclusive'),-1000);assert.throws(()=>exGST(100,''),/GST/)
})
test('half-cent credits round symmetrically with positive source costs',()=>{
 assert.equal(roundMoney(-100.005),-100.01);assert.equal(roundMoney(100.005),100.01)
})
test('invalid programme dates, negative commitments and missing supplier are rejected',()=>{
 assert.throws(()=>validateWorkflow('programme','Frame',{owner:'Carpenter',start_on:'2026-09-30',finish_on:'2026-09-29'}),/Finish/)
 assert.throws(()=>validateWorkflow('purchase_order','Frame',{supplier:'Timber',source_amount:-100,tax_basis:'exclusive'}),/credit/)
 assert.throws(()=>validateWorkflow('bill','Credit',{source_amount:-100,tax_basis:'exclusive'}),/Supplier/)
})
test('missing dependency is a blocker, not an all-clear',()=>{
 const r:any={id:'a',kind:'programme',status:'confirmed',payload:{dependencies:['b'],finish_on:'2026-09-20'}}
 assert.deepEqual(programmeReadiness(r,[r],'2026-09-26'),{blockers:['Missing dependency'],overdue:true})
})
