import test from 'node:test'
import assert from 'node:assert/strict'
import {requestedEstimateBatch,documentWorkerCount} from './continuation.ts'
test('continuation requires one explicit batch, with no wildcard or global fallback',()=>{
 for(const value of [null,'','all','*','not-a-uuid','00000000-0000-0000-0000-000000000000&all=true'])assert.equal(requestedEstimateBatch(value),null)
 assert.equal(requestedEstimateBatch('4ba688d4-ae29-4ee2-a4f0-f75172f9f6f4'),'4ba688d4-ae29-4ee2-a4f0-f75172f9f6f4')
})
test('initial document concurrency is bounded by this batch and a ceiling of three',()=>{
 assert.equal(documentWorkerCount(1),1);assert.equal(documentWorkerCount(2),2);assert.equal(documentWorkerCount(7),3);assert.equal(documentWorkerCount(30),3)
 for(const n of [0,-1,NaN,Infinity,1.5])assert.equal(documentWorkerCount(n),0)
})
