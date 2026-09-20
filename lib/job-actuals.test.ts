import test from 'node:test'
import assert from 'node:assert/strict'
import {jobActuals} from './job-actuals.ts'
test('shared actuals count priced labour once and preserve outstanding cost types',()=>{
 const costs=[{id:'c',description:'Frame',trade_category_id:2,amount:500,cost_kind:'committed' as const}],hours=[{id:'a',hours:2,hourly_rate:50},{id:'b',hours:3,hourly_rate:null}]
 assert.equal(jobActuals(costs,hours,false).reduce((s,r)=>s+r.amount,0),600)
 assert.equal(jobActuals(costs,hours,true).reduce((s,r)=>s+r.amount,0),500)
 assert.equal(jobActuals(costs,hours,false)[0].cost_kind,'committed')
})
