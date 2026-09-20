const assert=require('node:assert/strict')
const base='http://127.0.0.1:3221',job='20000000-0000-4000-8000-000000000001',builder='10000000-0000-4000-8000-000000000001'
const headers={authorization:'Bearer local-fixture-service','x-worka-builder-id':builder,'Content-Type':'application/json'}
async function call(path,body,method='PUT'){const r=await fetch(base+path,{headers,method:body?method:'GET',...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()}}
async function main(){const checks=[],url=`/api/jobs/${job}/control-plan`
 assert.equal((await fetch(base+'/api/business/profit-control')).status,401);checks.push('Anonymous control centre access denied')
 assert.equal((await call('/api/jobs/20000000-0000-4000-8000-000000000002/control-plan')).status,404);checks.push('Cross-builder job read denied')
 let r=await call(`/api/jobs/${job}/intelligence`,{action:'settings',captureBaseline:true,originalContract:116736,settings:{jobType:'renovation',region:'Sydney',complexity:'architectural',constructionType:'timber',size:200,labourIncluded:false,sourceTaxBasis:'exclusive',taxReconciled:true,targetMargin:null,contingency:0,estimatedHours:{2:180}}},'POST')
 assert.equal(r.status,200,JSON.stringify(r));r=await call(url);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.control.profit,null);checks.push('Unconfirmed partial costs do not publish profit')
 r=await call(url,{revision:0,confirm:true,cash_received:70000,cash_paid:50000,cash_as_of:'2026-09-01',start_on:'2026-10-01',finish_on:'2026-10-31',lead_worker_id:'70000000-0000-4000-8000-000000000001'})
 assert.equal(r.status,200,JSON.stringify(r));r=await call(url);assert.equal(r.data.control.profit,10636);assert.equal(r.data.control.leakage,14900);assert.equal(r.data.control.cash,20000);checks.push('Confirmed forecast reconciles baseline, actual costs and cash')
 r=await call('/api/business/profit-control');assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.totals.forecastProfit,10636);assert.equal(r.data.totals.unbilled,1200);assert.ok(r.data.exceptions.some(e=>e.id.endsWith(':leakage')));checks.push('Business and Today share financial totals and actionable leakage')
 r=await call(url,{revision:0,confirm:true,start_on:'2026-02-30',finish_on:'2026-03-01'});assert.equal(r.status,400);r=await call(url,{revision:0,confirm:true,cash_received:12});assert.equal(r.status,400);checks.push('Invalid dates and partial cash records rejected')
 r=await call('/api/business/compliance',{worker_id:'70000000-0000-4000-8000-000000000001',kind:'insurance',evidence:'Isolated sample policy',expires_on:'2026-01-01',confirmed:true},'POST');assert.equal(r.status,200,JSON.stringify(r));r=await call('/api/business/profit-control');assert.ok(r.data.exceptions.some(e=>e.id.startsWith('compliance:')));checks.push('Evidence expiry surfaces in exceptions')
 r=await call('/api/business/financial-profile',{cash_flow:{opening:1000,weeks:Array.from({length:13},()=>({inflow:0,outflow:200})),complete:true,startOn:'2026-09-20'}});assert.equal(r.status,200,JSON.stringify(r));r=await call('/api/business/profit-control');assert.equal(r.data.cash.lowest,-1600);assert.ok(r.data.exceptions.some(e=>e.id==='cash:deficit'));checks.push('Dated thirteen-week cash forecast surfaces a deficit')
 console.log(JSON.stringify({passed:checks.length,checks},null,2))
}
main().catch(e=>{console.error(e);process.exitCode=1})
