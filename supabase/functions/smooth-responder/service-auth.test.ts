import test from 'node:test'
import assert from 'node:assert/strict'
import {isServiceRoleRequest} from './service-auth.ts'
const url='https://test-project.supabase.co'
const token=(role='service_role',ref='test-project')=>'eyJ0eXAiOiJKV1QifQ.'+Buffer.from(JSON.stringify({role,ref})).toString('base64url')+'.untrusted-signature'
test('exact configured service key accepts case-insensitive Bearer without database lookup',async()=>{
 assert.equal(await isServiceRoleRequest('bearer configured','configured',url,async()=>{throw Error('must not call')}),true)
})
test('missing, malformed, anonymous, authenticated and foreign-project tokens cannot authorize',async()=>{
 for(const header of [null,'Basic configured','Bearer ', 'Bearer garbage','Bearer '+token('anon'),'Bearer '+token('authenticated'),'Bearer '+token('service_role','other')]) {
  assert.equal(await isServiceRoleRequest(header,'configured',url,async()=>{throw Error('must not call')}),false)
 }
 assert.equal(await isServiceRoleRequest('Bearer configured','',url),false)
})
test('alternate service token requires project verification with a zero-row HEAD',async()=>{
 let calls=0;const alternate=token()
 assert.equal(await isServiceRoleRequest('Bearer '+alternate,'configured',url,async(input,init)=>{
  calls++;assert.equal(input,url+'/rest/v1/estimating_access?select=builder_id&limit=0');assert.equal(init?.method,'HEAD');assert.equal(init?.redirect,'error');
  assert.deepEqual(init?.headers,{apikey:alternate,Authorization:'Bearer '+alternate});return new Response(null,{status:200})
 }),true);assert.equal(calls,1)
})
test('decoded or forged service claim is insufficient; verification failures fail closed',async()=>{
 for(const status of [401,403,404,500,302]) assert.equal(await isServiceRoleRequest('Bearer '+token(),'configured',url,async()=>new Response(null,{status})),false)
 assert.equal(await isServiceRoleRequest('Bearer '+token(),'configured',url,async()=>{throw Error('timeout')}),false)
})
