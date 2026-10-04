import test from 'node:test'
import assert from 'node:assert/strict'
import {allWalls,buildingDimensions,floorArea,levels,measurementError,rectangleGeometry,resizeLevel,roofArea} from './studio-geometry.ts'
import {cloneFloor,publicBuilding,validBuilding,isolateFloorIds} from './studio-building.ts'
import {newWorkspace,parseWorkspace,revisionIssues} from './studio-workspace.ts'
import {acceptEstimate,quantity,revise,totals} from './project-studio.ts'
import type {Line} from './project-studio.ts'
const item=(source:Line['source']):Line=>({id:'item',name:'Area allowance',trade:'Structure',unit:'m²',quantity:0,rate:100,source,included:true,allowance:false,note:'',rateVerified:true})
const building=()=>{const g=rectangleGeometry(8,6,2.7);g.verified=true;return {...g,storeys:[{id:'upper',name:'First floor',elevation:3,geometry:cloneFloor(g)}]}}
test('upper floors have distinct identities and contribute to linked quantities',()=>{
 const g=building();assert.equal(floorArea(g),96);assert.equal(allWalls(g).length,8);assert.equal(new Set(allWalls(g).map(w=>w.id)).size,8)
 assert.equal(quantity(item('area'),buildingDimensions(g)),96);assert.equal(quantity(item('perimeter'),buildingDimensions(g)),56)
 assert.ok(validBuilding(g));const w=newWorkspace();w.project=revise(w.project,{design:buildingDimensions(g),lines:[item('area')]});assert.ok(parseWorkspace(w));assert.ok(revisionIssues(w.project.working).some(s=>s.includes('Verify')))
})
test('floor resize changes quantities without altering accepted scope or wall identity',()=>{
 const w=newWorkspace();const g=rectangleGeometry(8,6,2.7);g.verified=true
 w.project=revise(w.project,{design:buildingDimensions(g),lines:[item('area')]});w.project=acceptEstimate(w.project)
 const next=resizeLevel(g,1.25,1);const p=revise(w.project,{design:buildingDimensions(next)})
 assert.equal(next.walls[0].id,g.walls[0].id);assert.equal(totals(p.working).cost,6000);assert.equal(totals(p.baseline!).cost,4800);assert.equal(p.baseline!.design.width,8)
})
test('dimension discrepancies survive resize and block approval even with verified flag',()=>{
 const g=rectangleGeometry(8,6,2.7);g.checks=[{id:'d1',label:'Overall width',a:g.walls[0].a,b:g.walls[0].b,expected:8,tolerance:.05,source:'A101'}]
 const next=resizeLevel(g,1.1,1);next.verified=true;assert.ok(Math.abs(measurementError(next.checks![0])-.8)<1e-8)
 const w=newWorkspace();w.project=revise(w.project,{design:buildingDimensions(next),lines:[item('area')]});assert.ok(revisionIssues(w.project.working).some(s=>s.includes('discrepancies')))
})
test('room and roof quantities use their own geometry and removed room links are flagged',()=>{
 const g=rectangleGeometry(8,6,2.7);g.rooms=[{id:'room',name:'Bedroom',polygon:[{x:0,y:0},{x:3,y:0},{x:3,y:4},{x:0,y:4}],finish:'carpet',furniture:'bedroom'}];g.roof={style:'gable',pitch:30,overhang:.5,axis:'x',colour:'#556677'}
 const l={...item('room-area'),roomId:'room'};assert.equal(quantity(l,buildingDimensions(g)),12);assert.ok(Math.abs(roofArea(g)-63/Math.cos(Math.PI/6))<1e-8)
 const w=newWorkspace();g.rooms=[];w.project=revise(w.project,{design:buildingDimensions(g),lines:[l]});assert.ok(revisionIssues(w.project.working).some(s=>s.includes('room')))
})
test('building validation rejects duplicate identities, nested floors and invalid room geometry',()=>{
 const g=building();g.storeys[0].geometry.walls[0].id=g.walls[0].id;assert.equal(validBuilding(g),false)
 const nested=building();(nested.storeys[0].geometry as any).storeys=[];assert.equal(validBuilding(nested),false)
 const outside=rectangleGeometry(8,6,2.7);outside.rooms=[{id:'bad',name:'Outside',polygon:[{x:7,y:0},{x:9,y:0},{x:9,y:2},{x:7,y:2}],finish:'tile',furniture:'none'}];assert.equal(validBuilding(outside),false)
})
test('client building keeps storeys and finishes while removing private measurement evidence',()=>{
 const g=building();g.storeys[0].geometry.source='private.pdf';g.storeys[0].geometry.walls[0].note='Supplier private quote';g.storeys[0].geometry.checks=[{id:'secret',label:'private',a:{x:0,y:0},b:{x:8,y:0},expected:8,tolerance:.05,source:'private report'}]
 const safe=publicBuilding(g);assert.equal(levels(safe).length,2);assert.equal(JSON.stringify(safe).includes('private'),false)
})

test('regenerating an upper floor isolates repeated extractor IDs without changing other floors',()=>{const g=building(),next=isolateFloorIds(g,'upper',rectangleGeometry(8,6,2.7));assert.notEqual(next.walls[0].id,g.walls[0].id);g.storeys[0].geometry=next;assert.ok(validBuilding(g));assert.equal(g.walls[0].id,'wall-0');assert.equal(isolateFloorIds(g,'upper',next).walls[0].id,next.walls[0].id)})

test('kitchen and lift illustration choices survive validation and client projection',()=>{
 const g=rectangleGeometry(8,6,2.7)
 for(const furniture of ['kitchen-island','kitchen-wall','lift'] as const){
  g.rooms=[{id:'kitchen',name:'Illustrative fixture',polygon:[{x:1,y:1},{x:4,y:1},{x:4,y:5},{x:1,y:5}],finish:'tile',furniture}]
  assert.ok(validBuilding(g));assert.equal(publicBuilding(g).rooms![0].furniture,furniture)
  const w=newWorkspace();w.project=revise(w.project,{design:buildingDimensions(g)});assert.ok(parseWorkspace(w))
 }
 g.rooms![0].furniture='invalid-fixture' as any;assert.equal(validBuilding(g),false)
})
