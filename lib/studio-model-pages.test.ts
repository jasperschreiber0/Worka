import test from 'node:test'
import assert from 'node:assert/strict'
import {modelPageSelection,appendModelPages} from './studio-model-pages.ts'
import type {DocumentReading} from './studio-document-reading.ts'
import type {PlanSource} from './studio-workspace.ts'
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
