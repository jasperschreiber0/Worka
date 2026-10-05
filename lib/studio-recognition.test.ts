import test from 'node:test'
import assert from 'node:assert/strict'
import { recognisedPlan } from './studio-recognition.ts'
import { newWorkspace, parseWorkspace, revisionIssues } from './studio-workspace.ts'
import { revise } from './project-studio.ts'
const points = [{ x: 100, y: 100 }, { x: 900, y: 100 }, { x: 900, y: 700 }, { x: 100, y: 700 }]
const input = () => ({ kind: 'floor-plan', dimension: { a: points[0], b: points[1], metres: 8 }, footprint: points, walls: points.map((a, i) => ({ name: `Wall ${i + 1}`, a, b: points[(i + 1) % 4], height: 2.7, thickness: .15, openings: i === 0 ? [{ kind: 'door', offset: 1, width: .9, height: 2.1, sill: 0 }] : [] })), warnings: ['Ceiling heights assumed.'] })

test('closed polygon rings preserve geometry without changing the source response',()=>{
 const data={...input(),footprint:[...points,points[0]],rooms:[{name:'Room',polygon:[...points,points[0]]}]},before=JSON.stringify(data)
 const result=recognisedPlan(data,1.25)
 assert.equal(result.geometry.footprint.length,4);assert.equal(result.geometry.rooms?.[0].polygon.length,4)
 assert.equal(result.design.width,8);assert.equal(JSON.stringify(data),before)
})
test('correction feedback reports every invalid wall opening without accepting any',()=>{
 const data=input();data.walls[0].openings[0].width=12
 data.walls[1].openings=[{kind:'window',offset:0,width:10,height:1,sill:1}]
 assert.throws(()=>recognisedPlan(data,1.25),(e:Error)=>e.message.includes('Wall 1')&&e.message.includes('Wall 2'))
})
test('misassigned opening centres report all wall and opening indices for focused repair',()=>{
 const data=input();data.walls[0].openings=[{kind:'door',offset:0,width:.9,height:2.1,sill:0,center:{x:400,y:300}} as any]
 data.walls[1].openings=[{kind:'door',offset:0,width:.9,height:2.1,sill:0,center:{x:600,y:400}} as any]
 assert.throws(()=>recognisedPlan(data,1.25),(e:Error)=>e.message.includes('wall 0 (Wall 1), opening 0')&&e.message.includes('wall 1 (Wall 2), opening 0')&&e.message.includes('perpendicular separation'))
})

test('room and opening failures are returned together for one coherent correction',()=>{
 const data={...input(),rooms:[{name:'Bedroom',polygon:[{x:50,y:100},{x:200,y:100},{x:200,y:300},{x:50,y:300}]}]}
 data.walls[0].openings[0].width=12
 assert.throws(()=>recognisedPlan(data,1.25),(e:Error)=>e.message.includes('Wall 1')&&e.message.includes('Bedroom')&&e.message.includes('outside'))
})
test('vision draft converts image coordinates to metres and survives project storage without approval', () => {
  const result = recognisedPlan(input(), 1.25)
  assert.equal(result.design.width, 8); assert.equal(result.design.depth, 6)
  assert.equal(result.geometry.walls[0].openings[0].width, .9)
  assert.equal(result.geometry.verified, false)
  const w = newWorkspace(); w.project = revise(w.project, { design: result.design })
  assert.ok(parseWorkspace(w)); assert.ok(revisionIssues(w.project.working).some(s => s.includes('Verify')))
})
test('manual calibration overrides AI dimension and missing scale cannot be guessed', () => {
  const data = { ...input(), dimension: null }
  assert.throws(() => recognisedPlan(data, 1.25), /No readable dimension/)
  assert.equal(recognisedPlan(data, 1.25, .02).design.width, 16)
})
test('unsupported pages, crossed footprints and out of image coordinates are rejected', () => {
  assert.throws(() => recognisedPlan({ ...input(), kind: 'unsupported' }, 1.25), /floor-plan page/)
  assert.throws(() => recognisedPlan({ ...input(), footprint: [points[0], points[2], points[1], points[3]] }, 1.25), /footprint/)
  assert.throws(() => recognisedPlan({ ...input(), footprint: [{ x: -1, y: 100 }, ...points.slice(1)] }, 1.25), /footprint/)
})
test('unsafe openings and implausible dimensions fail without silently dropping geometry', () => {
  const data = input(); data.walls[0].openings[0].width = 12
  assert.throws(() => recognisedPlan(data, 1.25), /openings/)
  assert.throws(() => recognisedPlan(input(), 1.25, .2), /implausible/)
  data.walls[0].height = NaN
  assert.throws(() => recognisedPlan(data, 1.25), /wall/)
})
test('opening centers produce metric offsets in either wall direction',()=>{
 const v=input();(v.walls[0].openings[0] as any).center={x:245,y:100};v.walls[0].openings[0].offset=87
 const r=recognisedPlan(v,1.25);assert.ok(Math.abs(r.geometry.walls[0].openings[0].offset-1)<1e-8)
 const reversed=input();reversed.walls[0].a=points[1];reversed.walls[0].b=points[0];(reversed.walls[0].openings[0] as any).center={x:245,y:100};
 assert.ok(Math.abs(recognisedPlan(reversed,1.25).geometry.walls[0].openings[0].offset-6.1)<1e-8)
})
test('off-wall, out-of-wall and overlapping centered openings remain blocked',()=>{
 const v=input();(v.walls[0].openings[0] as any).center={x:245,y:200};assert.throws(()=>recognisedPlan(v,1.25),/assigned wall/)
 ;(v.walls[0].openings[0] as any).center={x:100,y:100};assert.throws(()=>recognisedPlan(v,1.25),/Invalid openings/)
 ;(v.walls[0].openings[0] as any).center={x:245,y:100};v.walls[0].openings.push({...v.walls[0].openings[0]});assert.throws(()=>recognisedPlan(v,1.25),/Invalid openings/)
})
