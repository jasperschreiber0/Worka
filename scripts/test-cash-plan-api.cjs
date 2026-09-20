// Isolated localhost fixture only; never customer records.
const assert=require('node:assert/strict')
const root='http://127.0.0.1:3221',builder='10000000-0000-4000-8000-000000000001'
const headers={authorization:'Bearer local-fixture-service','x-worka-builder-id':builder,'Content-Type':'application/json'}
const request=(path,body,h=headers)=>fetch(root+path,{headers:h,...(body?{method:'PUT',body:JSON.stringify(body)}:{})})
async function main(){
 const checks=[]
 assert.equal((await request('/api/business/cash-plan',null,{})).status,401);checks.push('Anonymous cash access denied')
 let r=await request('/api/business/cash-plan'),d=await r.json();assert.equal(r.status,200)
 const plan={version:1,startOn:'2026-09-21',opening:10000,buffer:5000,accounts:'Isolated preview account',complete:true,entries:[{id:'receipt',label:'Sample receipt',direction:'in',amount:20000,dueOn:'2026-09-25',expectedOn:'2026-09-25',frequency:'once',endOn:'',note:'Synthetic fixture only',timing:'day'},{id:'wages',label:'Sample wages',direction:'out',amount:7000,dueOn:'2026-09-21',expectedOn:'2026-09-21',frequency:'weekly',endOn:'2026-10-05',note:'Synthetic fixture only',timing:'day'}]}
 const old=d.revision
 r=await request('/api/business/cash-plan',{plan,revision:old});assert.equal(r.status,200);d=await r.json();checks.push('Detailed plan saved')
 const fresh=await (await request('/api/business/cash-plan')).json();assert.deepEqual(fresh.plan,plan);assert.equal(fresh.legacy.weeks[0].inflow,20000);assert.equal(fresh.legacy.weeks[0].outflow,7000);checks.push('Reload preserves details and derives weekly totals')
 r=await request('/api/business/cash-plan',{plan,revision:'2000-01-01T00:00:00.000Z'});assert.equal(r.status,409);checks.push('Stale saves rejected')
 r=await request('/api/business/cash-plan',{plan:{...plan,entries:[{...plan.entries[0],amount:-1}]},revision:d.revision});assert.equal(r.status,400);checks.push('Invalid money rejected')
 const other=await (await request('/api/business/cash-plan',null,{...headers,'x-worka-builder-id':'10000000-0000-4000-8000-000000000002'})).json();assert.equal(other.plan,null);checks.push('Other builder cannot read the plan')
 r=await request('/api/business/financial-profile',{cash_flow:fresh.legacy});assert.equal(r.status,400);checks.push('Legacy endpoint cannot overwrite detailed plan')
 const today=await(await request('/api/business/profit-control')).json();assert.ok(today.exceptions.some(e=>e.id==='cash:buffer'));checks.push('Today surfaces buffer shortfall')
 console.log(JSON.stringify({passed:checks.length,checks},null,2))
}
main().catch(e=>{console.error(e);process.exitCode=1})
