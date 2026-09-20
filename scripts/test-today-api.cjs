// Isolated fixture only. Never accepts a production URL.
const assert=require('node:assert/strict')
const builder='10000000-0000-4000-8000-000000000001',job='20000000-0000-4000-8000-000000000001'
const headers={authorization:'Bearer local-fixture-service','x-worka-builder-id':builder,'Content-Type':'application/json'}
async function main(){
 const checks=[]
 assert.equal((await fetch('http://127.0.0.1:3221/api/business/profit-control')).status,401);checks.push('Anonymous access denied')
 const fixture={job_id:job,builder_id:builder,amount:1250,status:'sent',due_date:'2020-01-01'}
 let r=await fetch('http://127.0.0.1:3222/rest/v1/invoices',{method:'POST',headers,body:JSON.stringify([fixture,{...fixture,status:'paid'},{...fixture,builder_id:'10000000-0000-4000-8000-000000000002',amount:999999}])});assert.ok(r.ok)
 r=await fetch('http://127.0.0.1:3221/api/business/profit-control',{headers});assert.equal(r.status,200)
 const d=await r.json();assert.equal(d.operations.overdueTotal,1250);assert.equal(d.operations.overdueCount,1);checks.push('Owned overdue invoices only; paid and other tenants excluded')
 const invoice=d.exceptions.find(e=>e.id===`${job}:invoices`);assert.ok(invoice);assert.equal(invoice.href,`/jobs/${job}?section=money`);checks.push('Invoice action opens the correct job Money section')
 assert.ok(!d.exceptions.some(e=>e.id===`${job}:margin`) || !d.exceptions.some(e=>e.id===`${job}:leakage`));checks.push('Overlapping margin warnings are combined')
 assert.ok(d.exceptions.filter(e=>e.id.startsWith('cash:')).every(e=>e.href==='/business#cash-flow'));checks.push('Cash actions open the cash plan')
 console.log(JSON.stringify({passed:checks.length,checks},null,2))
}
main().catch(e=>{console.error(e);process.exitCode=1})
