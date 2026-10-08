import test from 'node:test'
import assert from 'node:assert/strict'
import {modelPageSelection,appendModelPages,estimatingPageSelection} from './studio-model-pages.ts'
import type {DocumentReading} from './studio-document-reading.ts'
import type {PlanSource} from './studio-workspace.ts'
test('builder estimating preserves existing plans, roofs, renders and elevations alongside proposed scope',()=>{
 const d={name:'Concept design.pdf',sheets:[{page:1,role:'other',title:'Cover'},{page:2,role:'plan',title:'Existing floor plan'},{page:3,role:'plan',title:'Existing roof plan'},{page:4,role:'other',title:'Concept design reference images'},{page:5,role:'other',title:'Concept design 2 render existing roof height'},{page:6,role:'other',title:'Concept design 2 render interior'},{page:7,role:'other',title:'Concept design 2 render rear'},{page:8,role:'floor-plan',title:'Concept design 2 floor plan'},{page:9,role:'other',title:'Concept design 2 roof plan'},{page:10,role:'elevation',title:'Northern and southern elevations'}]} as DocumentReading
 const selected=estimatingPageSelection(d);assert.deepEqual(selected.pages.map(p=>p.page),[8,2,3,5,6,7,9,10]);assert.equal(selected.pages.find(p=>p.page===2)?.role,'other');assert.ok(selected.omitted.some(p=>p.includes('reference images')))
})
test('drawing selection distinguishes proposed floors from existing, roof and detached scope',()=>{
 const d={name:'Architecture.pdf',sheets:[{page:1,role:'plan',title:'Existing floor plan'},{page:2,role:'plan',title:'Ground floor plan'},{page:3,role:'plan',title:'First floor plan'},{page:4,role:'plan',title:'Roof plan'},{page:5,role:'section',title:'Section A'},{page:6,role:'plan',title:'Secondary dwelling'}]} as DocumentReading
 const r=modelPageSelection(d);assert.deepEqual(r.pages.map(p=>p.page),[2,3,5]);assert.ok(r.omitted.some(s=>s.includes('Secondary dwelling')))
 assert.equal(modelPageSelection({...d,name:'Electrical First Draft.pdf'}).pages.length,0)
})
test('re-upload preserves calibrated pages and storage limits report omitted pages',()=>{
 const p={name:'A.pdf',page:1,image:'image',metresPerUnit:.02} as PlanSource
 assert.equal(appendModelPages([p],[{...p,metresPerUnit:0}]).pages[0].metresPerUnit,.02)
 const r=appendModelPages(Array.from({length:8},(_,i)=>({...p,page:i+1})),[{...p,page:9}]);assert.equal(r.pages.length,8);assert.equal(r.skipped.length,1)
})

test('window and door schedules accompany floor geometry instead of being treated as floors',()=>{
 const d={name:'Architecture.pdf',sheets:[{page:1,role:'plan',title:'Ground floor plan'},{page:2,role:'schedule',title:'Window & door schedule'},{page:3,role:'section',title:'Section'}]} as DocumentReading
 assert.deepEqual(modelPageSelection(d).pages.map(p=>[p.page,p.role]),[[1,'floor-plan'],[3,'section'],[2,'other']])
})
