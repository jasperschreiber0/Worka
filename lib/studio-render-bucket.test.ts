import test from 'node:test'
import assert from 'node:assert/strict'
import {createClient} from '@supabase/supabase-js'
import {ensurePrivateRenderBucket} from './studio-render-bucket.ts'

for (const missing of [{statusCode:'404',error:'not_found',message:'Bucket not found'}, {code:'NoSuchBucket',message:'Bucket not found'}]) {
  test(`first image provisions a private bucket despite legacy HTTP 400 (${JSON.stringify(missing)})`, async () => {
    let exists = false, creates = 0
    const client = createClient('https://storage-test.invalid','synthetic-test-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async (_input, init) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        assert.equal(body.public,false)
        assert.deepEqual(body.allowed_mime_types,['application/json'])
        exists=true;creates++
        return Response.json({name:'studio-renders'})
      }
      return exists ? Response.json({id:'studio-renders',public:false}) : Response.json(missing,{status:400})
    }}})
    await ensurePrivateRenderBucket(client.storage)
    await ensurePrivateRenderBucket(client.storage)
    assert.equal(creates,1)
  })
}

test('public buckets, forbidden access and storage outages fail closed', async () => {
  for (const result of [{data:{public:true},error:null},{data:null,error:{status:403,statusCode:'AccessDenied'}},{data:null,error:{status:500,statusCode:'InternalError'}}]) {
    await assert.rejects(()=>ensurePrivateRenderBucket({async getBucket(){return result},async createBucket(){assert.fail('Must not create or modify a bucket')}}),/unavailable/)
  }
})

test('a concurrent creation is accepted only after re-reading a private bucket', async () => {
  let reads=0
  await ensurePrivateRenderBucket({async getBucket(){return ++reads===1?{data:null,error:{status:404}}:{data:{public:false},error:null}},async createBucket(){return {error:{status:409}}}})
  assert.equal(reads,2)
  await assert.rejects(()=>ensurePrivateRenderBucket({async getBucket(){return {data:null,error:{status:404}}},async createBucket(){return {error:{status:403}}}}),/unavailable/)
})
