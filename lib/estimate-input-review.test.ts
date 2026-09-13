import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateInputReason } from './estimate-input-review.ts'
const base = { assumption_status: null, is_assumption: false, total: 100, pricing_source: 'manual' }
test('missing prices stay actionable even after acceptance; excluded work is omitted', () => {
 for (const total of [null, 0, NaN, -10]) assert.equal(estimateInputReason({...base,total,assumption_status:'accepted'}),'Price needed')
 assert.equal(estimateInputReason({...base,total:0,assumption_status:'excluded'}),null)
})
test('allowance totals do not require a unit rate and reviewed pricing leaves the list', () => {
 assert.equal(estimateInputReason({...base,pricing_source:'ai_allowance'}),'Check allowance or rate')
 assert.equal(estimateInputReason({...base,pricing_source:'ai_allowance',assumption_status:'adjusted'}),null)
 assert.equal(estimateInputReason({...base,is_assumption:true,assumption_status:'unresolved'}),'Confirm assumption')
 assert.equal(estimateInputReason(base),null)
})
test('waiting for a supplier stays on the input list and is never treated as reviewed',()=>{
 assert.equal(estimateInputReason({...base,review_state:'awaiting_quote'}),'Awaiting supplier quote')
 assert.equal(estimateInputReason({...base,review_state:'reviewed',total:null}),'Price needed')
})
