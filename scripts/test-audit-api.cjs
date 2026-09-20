// Requires preview-profitability.cjs; hardcoded localhost intentionally forbids production writes.
const assert=require('node:assert/strict'),base='http://127.0.0.1:3221',store='http://127.0.0.1:3222/rest/v1',builder='10000000-0000-4000-8000-000000000001',job='20000000-0000-4000-8000-000000000001',quote='30000000-0000-4000-8000-000000000001'
const headers={Authorization:'Bearer local-fixture-service','x-worka-builder-id':builder,'Content-Type':'application/json'}
async function main(){const checks=[];const req=async(path,body)=>{const r=await fetch(base+path,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()}}
 const url=`/api/jobs/${job}/financial-records`,initial=await req(url);assert.equal(initial.status,200);checks.push('Owner reads complete financial records')
 assert.equal((await fetch(base+url)).status,401);assert.equal((await req('/api/jobs/20000000-0000-4000-8000-000000000002/financial-records')).status,404);checks.push('Anonymous and cross-tenant reads rejected')
 const cost=initial.data.costs[0],edit={id:cost.id,revision:initial.data.revision,action:'correct_cost',values:{amount:61900,cost_kind:'incurred'},reason:'Isolated test supplier credit'}
 assert.equal((await req(url,{...edit,reason:'x'})).status,400);assert.equal((await req(url,edit)).status,200);assert.equal((await req(url,edit)).status,400);checks.push('Reason required, correction persists and stale repeat rejected')
 const changed=await req(url);assert.equal(Number(changed.data.costs.find(c=>c.id===cost.id).amount),61900)
 assert.equal((await req('/api/estimation/reconcile',{job_id:job,quote_id:quote})).status,410);checks.push('Old closeout cannot write')
 await fetch(`${store}/quotes?id=eq.${quote}`,{method:'PATCH',headers,body:JSON.stringify({status:'pending_review'})})
 const draft=await req(`/api/quotes/${quote}/send`,{});assert.equal(draft.status,200,JSON.stringify(draft.data));assert.ok(draft.data.pricing_review.fingerprint);assert.ok(!draft.data.draft.body.includes('Dave Nguyen'));assert.ok(!draft.data.draft.subject.includes('Nguyen Building'));checks.push('Live draft uses real profile and returns margin review')
 const sent=await req(`/api/quotes/${quote}/confirm-send`,{to:'nobody@example.invalid',subject:'Isolated quote test',body:'No provider configured',pricing_fingerprint:draft.data.pricing_review.fingerprint,margin_override_reason:'Isolated test only'})
 assert.equal(sent.status,503,JSON.stringify(sent.data));const row=await(await fetch(`${store}/quotes?id=eq.${quote}`)).json();assert.equal(row[0].status,'pending_review');checks.push('Missing email connection fails without marking quote sent')
 console.log(JSON.stringify({passed:checks.length,checks},null,2))
}
main().catch(e=>{console.error(e);process.exitCode=1})
