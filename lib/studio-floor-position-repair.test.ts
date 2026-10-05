import test from 'node:test'
import assert from 'node:assert/strict'
import {repairFloorPositions} from './studio-floor-position-repair.ts'
const original={floors:[{plan:{walls:[{openings:[{kind:'door',width:3.66,height:2.7,sill:0}]},{openings:[{kind:'window',width:1.2,height:1.5,sill:.9}]}],rooms:[{name:'Kitchen',polygon:[]}],warnings:[]}}]}
const patch={walls:[],openings:[{wallIndex:0,openingIndex:0,targetWallIndex:1,center:{x:100,y:200},sill:0}],rooms:[],footprint:[],warnings:[]}
test('moving openings between walls preserves counts, kinds and printed sizes exactly',()=>{
 const result=repairFloorPositions(original,patch).floors[0].plan
 assert.equal(result.walls[0].openings.length,0);assert.equal(result.walls[1].openings.length,2)
 assert.deepEqual(result.walls[1].openings[1],{kind:'door',width:3.66,height:2.7,sill:0,center:{x:100,y:200},offset:0})
 assert.equal(original.floors[0].plan.walls[0].openings.length,1)
})
test('duplicate, invalid and non-finite patches leave the original unchanged',()=>{
 for(const openings of [[...patch.openings,...patch.openings],[{...patch.openings[0],targetWallIndex:50}],[{...patch.openings[0],center:{x:NaN,y:0}}]])assert.throws(()=>repairFloorPositions(original,{...patch,openings}))
 assert.equal(original.floors[0].plan.walls[0].openings[0].width,3.66)
})
