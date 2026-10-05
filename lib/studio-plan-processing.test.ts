import test from 'node:test'
import assert from 'node:assert/strict'
import {planTimeRemaining,planServiceFailure} from './studio-plan-processing.ts'

test('a complex first pass can run beyond the old 95s cutoff without granting correction another full budget',()=>{
  assert.equal(planTimeRemaining(1000,96000),115000)
  assert.equal(planTimeRemaining(1000,171000),40000)
  assert.equal(planTimeRemaining(1000,211000),0)
  assert.equal(planTimeRemaining(1000,250000),0)
})
test('aborts explain the timeout and preserve the existing model',()=>{
  const result=planServiceFailure(new DOMException('This operation was aborted','AbortError'))
  assert.equal(result.status,504)
  assert.match(result.error,/Crop.*dimensions/)
  assert.match(result.error,/current model is unchanged/)
})
test('service errors never expose credentials or provider source text',()=>{
  for(const error of [{status:401,message:'secret drawing'}, {classification:'budget_refused',message:'private limit'},new Error('secret drawing')]){
    assert.doesNotMatch(JSON.stringify(planServiceFailure(error)),/secret|private/)
  }
  assert.equal(planServiceFailure({status:401}).status,503)
  assert.equal(planServiceFailure({classification:'budget_refused'}).status,503)
})
