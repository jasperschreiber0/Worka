import test from 'node:test'
import assert from 'node:assert/strict'
import {addFloorDetails,floorEnvelope,generateFloorStages,validFloorCheckpoint,repairFloor,drawingAreaWarning,drawingOpeningWarning} from './studio-floor-stages.ts'
import {newWorkspace,parseWorkspace} from './studio-workspace.ts'
const source='a'.repeat(64),plan={walls:[{name:'Wall',openings:[]}],rooms:[],warnings:[]}
const draft=()=>floorEnvelope(plan,source,'structure')
test('completed walls survive workspace save/reopen and remain tied to the source drawing',()=>{
 const w=newWorkspace();w.modelProgress={source,at:new Date().toISOString(),error:'Next step',draft:draft()}
 const restored=parseWorkspace(w)!
 assert.ok(restored);assert.ok(validFloorCheckpoint(restored.modelProgress?.draft,source));assert.equal(validFloorCheckpoint(restored.modelProgress?.draft,'b'.repeat(64)),false)
})
test('details cannot silently omit a wall or change its geometry',()=>{
 const next=addFloorDetails(draft(),{walls:[{wallIndex:0,openings:[{kind:'door',width:.9,height:2.1}]}],rooms:[],warnings:[]})
 assert.equal(next.stage,'details');assert.equal(next.floors[0].plan.walls[0].name,'Wall');assert.equal(plan.walls[0].openings.length,0)
 assert.throws(()=>addFloorDetails(draft(),{walls:[],rooms:[],warnings:[]}))
 assert.throws(()=>addFloorDetails(draft(),{walls:[{wallIndex:1,openings:[]}],rooms:[],warnings:[]}))
 assert.throws(()=>repairFloor(next,{walls:[{floorIndex:0,wallIndex:0,wall:{name:'Wall',openings:[]}}],rooms:[],footprints:[],warnings:[]}))
})
test('each stage is saved before the next request; reopening starts from saved progress',async()=>{
 const events:string[]=[],saved=draft()
 await generateFloorStages({} as any,new AbortController().signal,()=>{},async()=>{events.push('save')},saved,(async(_,o)=>{
  events.push('request');assert.deepEqual(JSON.parse(String(o?.body)).previousDraft,saved)
  return Response.json({checkpoint:saved,result:{geometry:{verified:false}}})
 }) as typeof fetch)
 assert.deepEqual(events,['request','save'])
})
test('save failure, cancellation, and provider failure stop further paid work',async()=>{
 for(const mode of ['save','cancel','provider']){
  let calls=0;const c=new AbortController()
  await assert.rejects(generateFloorStages({} as any,c.signal,()=>{},async()=>{if(mode==='save')throw new Error('Save failed');if(mode==='cancel')c.abort()},undefined,(async()=>{calls++;return Response.json({checkpoint:draft(),error:'Stopped'},{status:mode==='provider'?502:202})}) as typeof fetch))
  assert.equal(calls,1)
 }
})
test('large plans read bounded wall groups and keep earlier openings and rooms',()=>{
 let d=floorEnvelope({...plan,walls:Array.from({length:25},(_,i)=>({name:'Wall '+i,openings:[]}))},source,'structure') as any
 for(let start=0;start<25;start+=12){d=addFloorDetails(d,{walls:Array.from({length:Math.min(12,25-start)},(_,i)=>({wallIndex:start+i,openings:start+i===0?[{kind:'door',width:.9,height:2.1}]:[]})),rooms:start===0?[{name:'Kitchen',polygon:[]}]:[],warnings:[]});assert.equal(d.stage,start===24?'details':'structure')}
 assert.equal(d.checkedWalls.length,25);assert.equal(d.floors[0].plan.walls[0].openings.length,1);assert.equal(d.floors[0].plan.rooms[0].name,'Kitchen')
})
test('a repair that only changes warnings is saved but is not repeatedly submitted',async()=>{
 const d={...draft(),stage:'details'},next={...d,warnings:['No supported correction']};let calls=0,saves=0
 await assert.rejects(generateFloorStages({} as any,new AbortController().signal,()=>{},async()=>{saves++},d,(async()=>{calls++;return Response.json({checkpoint:next,error:'Opening outside wall'},{status:422})}) as typeof fetch),/automatic retries have stopped/)
 assert.equal(calls,1);assert.equal(saves,1)
})
test('printed area discrepancy stays visible without confusing an unrelated total with floor area',()=>{
 const p={text:[{x:10,y:10,text:'GROSS FLOOR AREA:'},{x:10,y:30,text:'TOTAL:'},{x:70,y:30,text:'341.6m'}]} as any
 assert.match(drawingAreaWarning(p,376.56)!,/10.2% difference/);assert.equal(drawingAreaWarning(p,341.6),null)
 assert.equal(drawingAreaWarning({text:p.text.slice(1)} as any,376.56),null)
})
test('opening coverage counts unique tags and does not claim tags prove geometry',()=>{
 const p={text:[{text:'D01 D01 W 02 W02'}]} as any
 assert.match(drawingOpeningWarning(p,1)!,/2 distinct/);assert.match(drawingOpeningWarning(p,1)!,/Tags can refer to schedules or assemblies/);assert.equal(drawingOpeningWarning(p,2),null)
})
