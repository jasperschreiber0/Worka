import {test} from 'node:test'
import assert from 'node:assert/strict'
import {pricingIntegrityIssues,shouldSavePrice} from './pricing-integrity.ts'
test('document lump sums are saved even without a unit rate',()=>{
 assert.equal(shouldSavePrice({rate:null,total:3720}),true)
 assert.equal(shouldSavePrice({rate:null,total:null}),false)
})
test('per-line markup and excluded scope do not cause false total errors',()=>{
 assert.deepEqual(pricingIntegrityIssues([{description:'PS',total:100,margin_pct:0},{description:'Measured',quantity:2,rate:50,total:100,margin_pct:15},{description:'Excluded',total:999,assumption_status:'excluded'}],200),[])
})
test('stale quote totals, inconsistent arithmetic and category matches block review',()=>{
 assert.equal(pricingIntegrityIssues([{description:'Pool cover',total:120,pricing_source:'category_rate'}],120).length,1)
 assert.equal(pricingIntegrityIssues([{description:'Measured',quantity:2,rate:50,total:80}],100).length,2)
 assert.equal(pricingIntegrityIssues([{description:'Invalid',total:-1}],-1).length,1)
})
