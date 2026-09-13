import { test } from 'node:test'
import assert from 'node:assert/strict'
import { savedInputPricing } from './saved-estimate-input.ts'
const item = { quantity: 4, unit: 'm2', rate: null, total: null, pricing_type: 'measured', assumption_status: 'unresolved' }
test('saved measured inputs update the amount and resolve the input flag', () => {
 assert.deepEqual(savedInputPricing(item, { rate: 125.25 }), { total: 501, assumption_status: 'adjusted' })
})
test('missing quantity or unit remains unresolved', () => {
 assert.equal(savedInputPricing({ ...item, quantity: null }, { rate: 100 }).assumption_status, 'unresolved')
 assert.equal(savedInputPricing({ ...item, unit: null }, { rate: 100 }).assumption_status, 'unresolved')
})
test('allowance input is a total, not multiplied by extracted quantity', () => {
 assert.deepEqual(savedInputPricing({ ...item, pricing_type: 'provisional_sum' }, { rate: 2000 }), { total: 2000, assumption_status: 'adjusted' })
})
test('description-only edits preserve existing allowance amount and unresolved review', () => {
 assert.deepEqual(savedInputPricing({ ...item, total: 2400, pricing_type: 'pc_allowance' }, {}), { total: 2400 })
})
test('quantity edits recompute existing unit rate without silently accepting scope', () => {
 assert.deepEqual(savedInputPricing({ ...item, rate: 100, total: 400 }, { quantity: 5 }), { total: 500 })
})
test('excluded work stays excluded when its rate changes', () => {
 assert.deepEqual(savedInputPricing({ ...item, assumption_status: 'excluded' }, { rate: 100 }), { total: 400 })
})

test('explicitly clearing a rate clears the amount and reopens input', () => {
 assert.deepEqual(savedInputPricing({...item,rate:100,total:400,assumption_status:'adjusted'},{rate:null}),{total:null,assumption_status:'unresolved'})
})
