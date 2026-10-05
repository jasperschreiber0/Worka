import {recognisedPlan,recognitionSchema} from './studio-recognition.ts'
import {buildingDimensions,geometryBounds} from './studio-geometry.ts'
import type {Geometry,Point} from './studio-geometry.ts'
import {validBuilding} from './studio-building.ts'
import type {drawingSetInput} from './studio-api-input.ts'
export const setSchema={type:'object',required:['floors','warnings'],properties:{warnings:{type:'array',items:{type:'string'}},floors:{type:'array',maxItems:5,items:{type:'object',required:['name','pageIndex','elevation','offsetX','offsetY','alignmentEvidence','plan'],properties:{name:{type:'string'},pageIndex:{type:'integer'},elevation:{type:'number'},offsetX:{type:'number'},offsetY:{type:'number'},alignmentEvidence:{type:'string'},plan:recognitionSchema}}}}}
export function recognisedSet(v:any,pages:ReturnType<typeof drawingSetInput>){
 if(v&&Array.isArray(v.floors)&&v.floors.length===0){
  const reasons=Array.isArray(v.warnings)?v.warnings.filter((s:unknown)=>typeof s==='string'&&s.length<=1000).slice(0,3).join(' '):''
  throw new Error('No floor plan could be reconstructed. '+(reasons||'Choose the floor-plan page showing the walls and a readable dimension, then try again.'))
 }
 if(!v||!Array.isArray(v.floors)||!v.floors.length||v.floors.length>5||!Array.isArray(v.warnings)||v.warnings.length>40||v.warnings.some((s:any)=>typeof s!=='string'||s.length>1000))throw new Error('The drawing set did not produce a usable building draft.')
 const warnings:string[]=[...v.warnings],used=new Set<number>()
 const failures:string[]=[]
 const floors=v.floors.map((f:any,i:number)=>{
  if(typeof f.name!=='string'||f.name.length>100||!Number.isInteger(f.pageIndex)||!pages[f.pageIndex]||used.has(f.pageIndex)||![f.elevation,f.offsetX,f.offsetY].every(Number.isFinite)||f.elevation<0||f.elevation>30||Math.abs(f.offsetX)>100||Math.abs(f.offsetY)>100||typeof f.alignmentEvidence!=='string'||!f.alignmentEvidence.trim()||f.alignmentEvidence.length>1000)throw new Error('Floor alignment or sheet references were incomplete. Nothing has been replaced.')
  used.add(f.pageIndex);const p=pages[f.pageIndex],source=p.name+' · page '+p.page+(p.revision?' · revision '+p.revision:'')
  let result;try{result=recognisedPlan(f.plan,p.aspect,p.metresPerUnit,source)}catch(e){failures.push(f.name+': '+(e instanceof Error?e.message:'Invalid floor'));return null}
  const g=result.geometry,b=geometryBounds(g)
  const move=(p:Point)=>({x:p.x-b.minX+f.offsetX,y:p.y-b.minY+f.offsetY})
  const geometry:Geometry={...g,footprint:g.footprint.map(move),walls:g.walls.map(w=>({...w,a:move(w.a),b:move(w.b)})),rooms:g.rooms?.map(r=>({...r,polygon:r.polygon.map(move)})),checks:g.checks?.map(m=>({...m,a:move(m.a),b:move(m.b)}))}
  warnings.push(f.name+': '+f.alignmentEvidence,...result.warnings.map(s=>f.name+': '+s))
  return {id:crypto.randomUUID(),name:f.name,elevation:f.elevation,geometry}
 }).filter((f:any)=>f!==null).sort((a:any,b:any)=>a.elevation-b.elevation)
 if(failures.length)throw new Error(failures.join('\n'))
 if(floors[0].elevation!==0||floors.some((f:any,i:number)=>i&&f.elevation<=floors[i-1].elevation))throw new Error('Floors must have distinct elevations, starting at zero. Confirm levels against the sections.')
 pages.forEach((p,i)=>{if(!used.has(i))warnings.push(p.name+' page '+p.page+': supporting or unmodelled sheet; verify that no required floor was omitted.')})
 const geometry:Geometry={...floors[0].geometry,storeys:floors.slice(1)}
 if(!validBuilding(geometry))throw new Error('The combined building geometry is invalid. Review scale and alignment.')
 return {geometry,design:buildingDimensions(geometry),warnings,groundName:floors[0].name}
}
