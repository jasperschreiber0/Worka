import test from 'node:test'
import assert from 'node:assert/strict'
import {applyModelCorrection} from './studio-model-correction.ts'
const wall={name:'Kitchen',height:2.7,openings:[{kind:'window',width:2.4,height:1,sill:2.1}]}
const previous={floors:[{plan:{walls:[wall,{name:'Other',height:2.7,openings:[]}],rooms:[{name:'Kitchen',polygon:[]}],footprint:[]}}],warnings:[]}
const patch={walls:[{floorIndex:0,wallIndex:0,wall:{...wall,height:3.4}}],rooms:[],footprints:[],warnings:['Height read from section']}
test('a focused correction preserves untouched elements and source data',()=>{const next=applyModelCorrection(previous,patch);assert.equal(next.floors[0].plan.walls[0].height,3.4);assert.equal(previous.floors[0].plan.walls[0].height,2.7);assert.deepEqual(next.floors[0].plan.walls[1],previous.floors[0].plan.walls[1]);assert.equal(next.warnings.length,1)})
test('cannot remove or shrink openings, target absent walls, or apply duplicate repairs',()=>{
 for(const change of [{wall:{...wall,openings:[]}},{wall:{...wall,openings:[{...wall.openings[0],width:2}]}},{wallIndex:2},{floorIndex:-1}])assert.throws(()=>applyModelCorrection(previous,{...patch,walls:[{...patch.walls[0],...change}]}))
 assert.throws(()=>applyModelCorrection(previous,{...patch,walls:[patch.walls[0],patch.walls[0]]}))
})
test('can move a misassigned opening to its actual wall without losing or duplicating it',()=>{
 const next=applyModelCorrection(previous,{...patch,walls:[{floorIndex:0,wallIndex:0,wall:{...wall,openings:[]}},{floorIndex:0,wallIndex:1,wall:{name:'Other',openings:wall.openings}}]})
 assert.equal(next.floors[0].plan.walls[0].openings.length,0);assert.deepEqual(next.floors[0].plan.walls[1].openings,wall.openings)
 assert.throws(()=>applyModelCorrection(previous,{...patch,walls:[{floorIndex:0,wallIndex:1,wall:{name:'Other',openings:wall.openings}}]}))
})
