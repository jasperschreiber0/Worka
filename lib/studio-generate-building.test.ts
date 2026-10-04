import test from 'node:test'
import assert from 'node:assert/strict'
import {generateBuildingDraft} from './studio-generate-building.ts'

test('corrects a rejected model in a fresh request carrying the rejected draft',async()=>{
 const bodies:any[]=[],draft={floors:[{name:'Ground'}]},messages:string[]=[]
 const request=(async(_url:any,options:any)=>{bodies.push(JSON.parse(options.body));return bodies.length===1?Response.json({error:'Opening does not fit',rejectedDraft:draft},{status:422}):Response.json({geometry:{verified:false}})}) as typeof fetch
 const result=await generateBuildingDraft([],new AbortController().signal,m=>messages.push(m),request)
 assert.equal(bodies.length,2);assert.equal(bodies[0].previousDraft,undefined);assert.deepEqual(bodies[1].previousDraft,draft);assert.equal(result.geometry.verified,false);assert.equal(messages.length,1)
})
test('does not retry authentication, server failure or two rejected corrections',async()=>{
 for(const status of [401,403,502,422]){
  let calls=0
  await assert.rejects(generateBuildingDraft([],new AbortController().signal,()=>{},(async()=>{calls++;return Response.json({error:'Needs review',rejectedDraft:{floors:[]}},{status})}) as typeof fetch),/Needs review/)
  assert.equal(calls,status===422?3:1)
 }
})
test('stopping after the first response prevents another paid request',async()=>{
 let calls=0;const c=new AbortController()
 await assert.rejects(generateBuildingDraft([],c.signal,()=>c.abort(),(async()=>{calls++;return Response.json({error:'Needs review',rejectedDraft:{floors:[]}},{status:422})}) as typeof fetch),{name:'AbortError'})
 assert.equal(calls,1)
})
test('persists the final rejected response and resumes the saved draft in a later run',async()=>{
 const saved:any[]=[],draft={floors:[{name:'Ground'}]},bodies:any[]=[]
 await assert.rejects(generateBuildingDraft([],new AbortController().signal,()=>{},(async(_url,options)=>{bodies.push(JSON.parse(String(options?.body)));return Response.json({error:'Opening needs correction',rejectedDraft:draft},{status:422})}) as typeof fetch,{previousDraft:draft,save:async(d,e)=>{saved.push({d,e})}}))
 assert.equal(saved.length,3);assert.deepEqual(bodies[0].previousDraft,draft);assert.deepEqual(saved[2].d,draft)
})
test('failed checkpoint stops further paid correction attempts',async()=>{
 let calls=0
 await assert.rejects(generateBuildingDraft([],new AbortController().signal,()=>{},(async()=>{calls++;return Response.json({error:'Needs correction',rejectedDraft:{floors:[{}]}},{status:422})}) as typeof fetch,{save:async()=>{throw new Error('Storage unavailable')}}),/Storage unavailable/)
 assert.equal(calls,1)
})
