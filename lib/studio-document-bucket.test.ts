import test from 'node:test'
import assert from 'node:assert/strict'
import {ensurePrivateRenderBucket} from './studio-render-bucket.ts'
test('PDF original bucket remains private and restricts type and size',async()=>{
 let created=false
 await ensurePrivateRenderBucket({async getBucket(name){assert.equal(name,'studio-documents');return created?{data:{public:false},error:null}:{data:null,error:{status:404}}},async createBucket(name,options){assert.equal(name,'studio-documents');assert.deepEqual(options,{public:false,allowedMimeTypes:['application/pdf'],fileSizeLimit:20971520});created=true}},'studio-documents',['application/pdf'],20971520)
 assert.ok(created)
})
