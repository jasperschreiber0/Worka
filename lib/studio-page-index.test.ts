import test from 'node:test'
import assert from 'node:assert/strict'
import {identifySheet,recommendedSheets,floorSupportingPages,stageSupportingPages} from './studio-page-index.ts'
import {drawingFingerprint} from './studio-model-progress.ts'
import type {PlanSource} from './studio-workspace.ts'
import {newWorkspace,parseWorkspace} from './studio-workspace.ts'

test('cover registers cannot masquerade as floor plans',()=>{
 assert.equal(identifySheet(1,'DRAWING INDEX CD-110 GROUND FLOOR PLAN CD-500 WALL LOCATION PLAN CD-600 WINDOW SCHEDULE CD-601 DOOR SCHEDULE').purpose,'other')
})
test('sheet title block takes precedence over references inside a drawing',()=>{
 assert.equal(identifySheet(12,'Refer to ground floor plan PROJECT PROJECT NUMBER 1:50 TT PROP. WINDOW SCHEDULE CD-600 A2').purpose,'openings')
 assert.equal(identifySheet(16,'GROUND FLOOR PLAN PROJECT PROJECT NUMBER PROP. REFLECTED CEILING PLAN CD-624').purpose,'other')
})
test('recommends wall, setout and opening evidence beyond page eight',()=>{
 const pages=['DRAWING INDEX','SITE PLAN','GROUND FLOOR PLAN','ROOF PLAN','ELEVATION SHEET 1','ELEVATION SHEET 2','SECTION SHEET 1','SECTION SHEET 2','SECTION SHEET 3','SECTION SHEET 4','WALL LOCATION PLAN GF','WINDOW SCHEDULE','DOOR SCHEDULE','WASTE MANAGEMENT PLAN','SETOUT PLAN','REFLECTED CEILING PLAN','EXTERNAL COLOUR SCHEDULE'].map((s,i)=>identifySheet(i+1,s))
 assert.deepEqual(recommendedSheets(pages),[3,11,12,13,15,7,5])
})
test('support changes invalidate saved progress; other jobs and floors are excluded',async()=>{
 const p={name:'A.pdf',page:3,role:'floor-plan',image:'data:image/jpeg;base64,AAAA',aspect:1,metresPerUnit:0} as PlanSource
 const support={...p,page:12,role:'other'} as PlanSource
 assert.deepEqual(floorSupportingPages(p,[p,support,{...support,name:'B.pdf'},{...p,page:4}]),[support])
 assert.notEqual(await drawingFingerprint([p]),await drawingFingerprint([p,support]))
})
test('generated draft assumptions and original PDF references survive save validation',()=>{
 const w=newWorkspace()
 w.plan={name:'A.pdf',page:3,image:'data:image/jpeg;base64,AAAA',aspect:1,metresPerUnit:0,originalId:'a'.repeat(64),recognition:{warnings:Array.from({length:40},()=> 'Check '.repeat(100))}}
 assert.ok(parseWorkspace(w))
 assert.equal(parseWorkspace({...w,plan:{...w.plan,originalId:'../../another-owner'}}),null)
})
test('each AI step receives bounded images relevant to its task',()=>{
 const supports=['WINDOW SCHEDULE','DOOR SCHEDULE','WALL LOCATION PLAN GF','SETOUT PLAN','SECTION SHEET 1','ELEVATION SHEET 1'].map((text,i)=>({page:i+1,text:[{text}]} as PlanSource))
 assert.deepEqual(stageSupportingPages(supports,'structure').map(p=>p.page),[4,3])
 assert.deepEqual(stageSupportingPages(supports,'details').map(p=>p.page),[1,2])
 assert.deepEqual(stageSupportingPages(supports,'repair').map(p=>p.page),[5,6])
})
