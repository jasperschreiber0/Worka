// Explicitly scoped to the two recorded synthetic identities. Never enumerate data.
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const {key,password}=JSON.parse(readFileSync('supabase/.temp/readiness-auth.json','utf8'))
const base='https://nfyuhsqvmmcdgbedhsxd.supabase.co'
const ids=['cad707b5-9759-49b1-88a7-d5c1eb1936b4','606b4aca-505a-4f55-8229-8904f0af6cd8']
const jobs=['3c0bcb86-863e-40f5-beb2-f17bd04db215','3b7f7c6d-2bed-44d7-a0ee-ca0d76680046']
const tokens=[], costs=[], results=[]
async function api(path,token,method='GET',body) {
  const res=await fetch(base+path,{method,headers:{apikey:key,...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json',Prefer:'return=representation'},body:body===undefined?undefined:JSON.stringify(body)})
  const text=await res.text(); return {status:res.status,data:text?JSON.parse(text):null}
}
function check(name,condition,detail='') { results.push({name,passed:condition,detail}); assert.ok(condition,name+': '+detail) }
try {
 for (let i=0;i<2;i++) {
  const login=await api('/auth/v1/token?grant_type=password',null,'POST',{email:`worka-readiness-202609071040-${i?'b':'a'}@example.invalid`,password})
  check('synthetic login '+i,login.status===200 && login.data.user.id===ids[i],JSON.stringify({status:login.status,error:login.data?.error_code,message:login.data?.msg}))
  tokens.push(login.data.access_token)
  const created=await api('/rest/v1/job_cost_entries',tokens[i],'POST',{builder_id:ids[i],job_id:jobs[i],description:'SYNTHETIC REST TEST',amount:7,cost_kind:'remaining'})
  check('owner cost INSERT '+i,created.status===201,String(created.status)); costs.push(created.data[0].id)
 }
 for(let i=0;i<2;i++) {
  const other=costs[1-i]
  for(const method of ['GET','PATCH','DELETE']) {
   const r=await api('/rest/v1/job_cost_entries?id=eq.'+other,tokens[i],method,method==='PATCH'?{amount:999}:undefined)
   check('tenant '+i+' cross-tenant '+method, r.status===200 && Array.isArray(r.data)&&r.data.length===0,String(r.status))
  }
  const denied=await api('/rest/v1/job_cost_entries',tokens[i],'POST',{builder_id:ids[1-i],job_id:jobs[1-i],description:'MUST REJECT',amount:1})
  check('tenant '+i+' cross-tenant INSERT',denied.status===403,String(denied.status))
 }
 for(const [role,token] of [['anon',null],['tenant-a',tokens[0]],['tenant-b',tokens[1]]]) {
  for(const table of ['intake_recovery_runs','ai_operations','ai_spend_daily','system_status','builder_knowledge_defaults','xero_connections','xero_import_items','xero_sync_runs','xero_oauth_transactions']) {
   const r=await api('/rest/v1/'+table+'?select=*&limit=0',token)
   check(role+' server-table '+table,[401,403].includes(r.status),String(r.status))
  }
  const r=await api('/rest/v1/rpc/consume_xero_oauth_state',token,'POST',{p_state_hash:'0'.repeat(64),p_builder_id:ids[0]})
  check(role+' OAuth RPC denied',[401,403].includes(r.status),String(r.status))
 }
} catch(error) {results.push({name:'test runner',passed:false,detail:error.message}); process.exitCode=1}
finally {
 for(let i=0;i<costs.length;i++) {const r=await api('/rest/v1/job_cost_entries?id=eq.'+costs[i],tokens[i],'DELETE');results.push({name:'cleanup exact cost '+costs[i],passed:r.status===200,detail:String(r.status)})}
 writeFileSync('supabase/verification/readiness-20260907/live-rest.json',JSON.stringify(results,null,2))
 console.log(JSON.stringify(results,null,2))
}
