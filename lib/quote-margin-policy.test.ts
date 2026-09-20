import test from 'node:test'
import assert from 'node:assert/strict'
import {quoteMarginPolicy} from './quote-margin-policy.ts'
const profile={annualRevenue:1000000,annualOverhead:200000,netProfitPct:10}
test('margin gate uses margin not markup and only requires below-overhead override',()=>{
 assert.equal(quoteMarginPolicy(80000,100000,profile).required,false)
 assert.equal(quoteMarginPolicy(85000,100000,profile).required,true)
 assert.equal(quoteMarginPolicy(80000,100000,profile).margin,20)
})
test('unknown overhead and zero selling price require an explicit decision',()=>{
 assert.equal(quoteMarginPolicy(80,100,null).required,true)
 assert.equal(quoteMarginPolicy(80,0,profile).required,true)
})
