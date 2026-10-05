import {recognitionSchema,recognisedPlan} from './studio-recognition.ts'
import {applyModelCorrection} from './studio-model-correction.ts'
import type {PlanSource} from './studio-workspace.ts'
import {polygonArea} from './studio-geometry.ts'

export const floorDetailSchema={type:'object',required:['walls','rooms','warnings'],properties:{
 walls:{type:'array',maxItems:150,items:{type:'object',required:['wallIndex','openings'],properties:{wallIndex:{type:'integer'},openings:recognitionSchema.properties.walls.items.properties.openings}}},
 rooms:{...recognitionSchema.properties.rooms,maxItems:80},warnings:{type:'array',maxItems:30,items:{type:'string',maxLength:500}},
}}
export function floorEnvelope(plan:any,source:string,stage:string){return {floors:[{plan}],warnings:[],source,stage,kind:'staged-floor-v1'}}
export function validFloorCheckpoint(d:any,source:string){return d?.kind==='staged-floor-v1'&&d.source===source&&['structure-check','structure','details','complete'].includes(d.stage)&&Array.isArray(d.floors)&&d.floors.length===1&&d.floors[0]?.plan&&JSON.stringify(d).length<=200000}
export function addFloorDetails(previous:any,details:any){
 const next=structuredClone(previous),plan=next.floors[0].plan
 const required=pendingWallIndexes(previous)
 if(!Array.isArray(details?.walls)||details.walls.length!==required.length)throw new Error('The opening-reading step did not check every requested wall. Completed walls remain saved.')
 if(!Array.isArray(details.rooms)||details.rooms.length>80||!Array.isArray(details.warnings)||details.warnings.length>30||details.warnings.some((s:any)=>typeof s!=='string'||s.length>500))throw new Error('Room details or assumptions were incomplete. Completed walls remain saved.')
 const seen=new Set<number>()
 for(const w of details.walls){if(!required.includes(w.wallIndex)||seen.has(w.wallIndex)||!Array.isArray(w.openings)||w.openings.length>30)throw new Error('Incomplete or duplicated wall details.');seen.add(w.wallIndex);plan.walls[w.wallIndex].openings=w.openings}
 if(!(previous.checkedWalls?.length))plan.rooms=details.rooms
 next.checkedWalls=[...(previous.checkedWalls||[]),...required]
 plan.warnings=[...plan.warnings,...details.warnings].slice(-30);next.stage=next.checkedWalls.length===plan.walls.length?'details':'structure';return next
}
export function pendingWallIndexes(d:any):number[]{return d.floors[0].plan.walls.map((_:any,i:number)=>i).filter((i:number)=>!d.checkedWalls?.includes(i)).slice(0,12)}
export function repairFloor(previous:any,patch:any){const next=applyModelCorrection(previous,patch);next.floors[0].plan.warnings=[...next.floors[0].plan.warnings,...patch.warnings].map((s:string)=>s.slice(0,500)).slice(-30);return next}
export function drawingAreaWarning(p:PlanSource,area:number):string|null{
 const texts=p.text||[],head=texts.find(t=>/^(gross floor area|floor areas?)\s*:?$/i.test(t.text.trim()))
 if(!head)return null
 const label=texts.find(t=>/^total\s*:?$/i.test(t.text.trim())&&Math.abs(t.x-head.x)<10&&t.y>head.y&&t.y-head.y<70)
 if(!label)return null
 const values=texts.filter(t=>t.x>label.x&&t.x-label.x<150&&Math.abs(t.y-label.y)<2&&/^\d+(?:\.\d+)?\s*m(?:²|2)?$/i.test(t.text.trim()))
 if(values.length!==1)return null
 const printed=parseFloat(values[0].text);if(!(printed>0)||Math.abs(area/printed-1)<=.05)return null
 return `Area check required: model footprint ${area.toFixed(1)} m²; drawing area-schedule total ${printed.toFixed(1)} m² (${(Math.abs(area/printed-1)*100).toFixed(1)}% difference). Check the traced boundaries and whether both totals include the same porches, garages and covered areas before using quantities.`
}
export function drawingOpeningWarning(p:PlanSource,count:number):string|null{
 const tags=new Set((p.text||[]).flatMap(t=>t.text.match(/\b[DW]\s?\d{1,3}\b/g)||[]).map(s=>s.replace(/\s/g,'')))
 return tags.size>count?`Coverage check required: the drawing contains ${tags.size} distinct door/window tags, but this draft contains ${count} openings. Tags can refer to schedules or assemblies; reconcile them against the drawing and supply missing schedules before using opening quantities.`:null
}
export function validateFloor(d:any,p:PlanSource){const result=recognisedPlan(d.floors[0].plan,p.aspect,p.metresPerUnit,p.name+' · page '+p.page);const warnings=[drawingAreaWarning(p,polygonArea(result.geometry.footprint)),drawingOpeningWarning(p,result.geometry.walls.reduce((n,w)=>n+w.openings.length,0))].filter((w):w is string=>!!w);return {...result,warnings:[...warnings,...result.warnings]}}

/** Checkpoint each completed step before paying for the next. A later run resumes it. */
export async function generateFloorStages(page:PlanSource,signal:AbortSignal,onProgress:(s:string)=>void,save:(draft:any,error:string)=>Promise<void>,previousDraft?:unknown,request:typeof fetch=fetch){
 let draft=previousDraft
 for(let i=0;i<8;i++){
  signal.throwIfAborted()
  onProgress(!draft?'Reading scale, outline and walls…':(draft as any).stage==='structure'?`Reading doors, windows and rooms. ${(draft as any).checkedWalls?.length||0} of ${(draft as any).floors[0].plan.walls.length} walls checked; completed steps are saved.`:'Checking the draft and repairing affected parts. Completed steps are saved…')
  const r=await request('/api/studio/recognise-floor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({page,previousDraft:draft}),signal})
  const data=await r.json();signal.throwIfAborted()
  const unchanged=r.status===422&&draft&&(draft as any).stage===data.checkpoint?.stage&&JSON.stringify((draft as any).floors)===JSON.stringify(data.checkpoint?.floors)
  if(data.checkpoint){await save(data.checkpoint,String(data.error||data.message||'Model in progress').slice(0,5000));draft=data.checkpoint}
  signal.throwIfAborted()
  if(unchanged)throw new Error((data.error||'The draft needs review.')+' No supported geometry change was returned. Progress is saved; automatic retries have stopped.')
  if(r.ok&&data.result)return data.result as ReturnType<typeof recognisedPlan>
  if(r.status===202||r.status===422&&data.checkpoint)continue
  throw new Error(data.error||'Model reading stopped. Saved progress can be resumed.')
 }
 throw new Error('The saved draft still needs measurement review. Resume to continue; your working model is unchanged.')
}
