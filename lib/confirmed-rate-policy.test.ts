import {test} from 'node:test'
import assert from 'node:assert/strict'
import {compatibleConfirmedRate,incompatiblePackageSelection} from './confirmed-rate-policy.ts'
test('confirmed rate reuse requires exact scope, unit, trade, location and active confirmation',()=>{
 const item={description:'Concrete slab 125mm',unit:'m2',trade_category_id:1}
 const rate={...item,state:'NSW',active:true}
 assert.equal(compatibleConfirmedRate(item,rate,'NSW'),true)
 for(const change of [{unit:'m3'},{trade_category_id:2},{description:'Concrete slab 200mm'},{active:false},{state:'VIC'}])assert.equal(compatibleConfirmedRate(item,{...rate,...change},'NSW'),false)
})
test('a sink mixer price cannot replace a kitchenette joinery package',()=>{
 assert.equal(incompatiblePackageSelection('Secondary dwelling kitchenette cabinetry package with sink','Kitchen Ionian sink mixer nickel'),true)
 assert.equal(incompatiblePackageSelection('Kitchen Ionian sink mixer nickel','Kitchen Ionian sink mixer nickel'),false)
})
