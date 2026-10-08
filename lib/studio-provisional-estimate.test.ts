import {test} from 'node:test'
import assert from 'node:assert/strict'
import {newWorkspace,parseWorkspace,clientProjection,approvalIssues} from './studio-workspace.ts'
import {applyProvisionalEstimate,pricingGroups} from './studio-provisional-estimate.ts'
import {totals} from './project-studio.ts'
import {newScopeReview} from './studio-scope.ts'
function fixture(){const w=newWorkspace(true);w.project.working.lines=[
 {id:'a',trade:'Structure',name:'Garage west · Framing',unit:'m²',source:'entered',quantity:20,rate:0,included:true,allowance:false,note:'Timber studs'},
 {id:'b',trade:'Structure',name:'Garage north · Framing',unit:'m²',source:'entered',quantity:18,rate:0,included:true,allowance:false,note:'Timber studs'},
 {id:'known',trade:'Interiors',name:'Kitchen supplier price',unit:'item',source:'entered',quantity:1,rate:5000,included:true,allowance:false,note:'Supplier quote',rateVerified:true},
 ];return w}
const output=(w:ReturnType<typeof fixture>)=>({groups:pricingGroups(w).map(g=>({id:g.id,unit:g.unit,material:55,labour:45,basis:'Timber studs, ordinary waste included.'})),additional:[{scope:'electrical',name:'Electrical provisional allowance',cost:18000,basis:'Assumed standard residential installation, no solar.'}],assumptions:['Confirm garage finishes and electrical inclusions.']})
test('measured wall packages share pricing without losing quantities or specifications',()=>{
 const w=fixture();w.project.working.lines=Array.from({length:180},(_,i)=>({...w.project.working.lines[0],id:'wall-'+i,name:'Wall '+i+' · Framing',source:'area' as const,packageId:'package-'+i}));
 const groups=pricingGroups(w);assert.equal(groups.length,1);assert.equal(groups[0].lineIds.length,180);
 const priced=applyProvisionalEstimate(w,{groups:[{id:groups[0].id,unit:'m²',material:55,labour:45,basis:'Timber studs, ordinary waste included.'}],additional:[],assumptions:[]});
 assert.equal(priced.project.working.lines.length,180);assert.ok(priced.project.working.lines.every(l=>l.rate===55&&l.labour===45));
 w.project.working.lines[0].note='Fire-rated wall';assert.equal(pricingGroups(w).length,2);
})
test('prices groups once, fills missing packages, preserves quotes, actuals and accepted work',()=>{const w=fixture(),original=JSON.stringify(w),priced=applyProvisionalEstimate(w,output(w));assert.equal(pricingGroups(w).length,1);assert.equal(priced.project.working.lines[2].rate,5000);assert.equal(priced.project.working.lines[0].rateVerified,false);assert.equal(priced.project.working.lines[0].waste,0);assert.equal(totals(priced.project.working).cost,26800);assert.deepEqual(priced.project.costs,w.project.costs);assert.deepEqual(priced.project.baseline,w.project.baseline);assert.equal(JSON.stringify(w),original);assert.ok(parseWorkspace(JSON.stringify(priced)));assert.ok(clientProjection(priced).current.total>0);assert.ok(clientProjection(priced).current.reviewRequired);assert.ok(approvalIssues(priced).length>0)})
test('rejects incomplete, duplicate and nonfinite pricing without mutating input',()=>{const w=fixture(),o=output(w);assert.throws(()=>applyProvisionalEstimate(w,{...o,groups:[]}));assert.throws(()=>applyProvisionalEstimate(w,{...o,groups:[{...o.groups[0],unit:'item'}]}));assert.throws(()=>applyProvisionalEstimate(w,{...o,groups:[...o.groups,...o.groups]}));assert.throws(()=>applyProvisionalEstimate(w,{...o,groups:[{...o.groups[0],material:Infinity}]}));assert.throws(()=>applyProvisionalEstimate(w,{...o,additional:[...o.additional,...o.additional]}));assert.equal(w.project.working.lines[0].rate,0)})
test('excluded and already-linked categories cannot gain a second allowance',()=>{const w=fixture();w.scopeReview=newScopeReview();w.scopeReview.items=w.scopeReview.items.map(s=>s.key==='electrical'?{...s,status:'excluded'}:s);assert.throws(()=>applyProvisionalEstimate(w,output(w)));w.scopeReview.items=w.scopeReview.items.map(s=>s.key==='electrical'?{...s,status:'included',lineIds:['known']}:s);assert.throws(()=>applyProvisionalEstimate(w,output(w)))})
test('refresh cannot duplicate a prior provisional scope package',()=>{const w=fixture(),priced=applyProvisionalEstimate(w,output(w));assert.throws(()=>applyProvisionalEstimate(priced,{groups:[],additional:output(w).additional,assumptions:[]}));assert.equal(pricingGroups(priced).length,0)})
