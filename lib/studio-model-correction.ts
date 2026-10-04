import {recognitionSchema} from './studio-recognition.ts'
export const correctionSchema={type:'object',required:['walls','rooms','footprints','warnings'],properties:{
 walls:{type:'array',maxItems:100,items:{type:'object',required:['floorIndex','wallIndex','wall'],properties:{floorIndex:{type:'integer'},wallIndex:{type:'integer'},wall:recognitionSchema.properties.walls.items}}},
 rooms:{type:'array',maxItems:100,items:{type:'object',required:['floorIndex','roomIndex','room'],properties:{floorIndex:{type:'integer'},roomIndex:{type:'integer'},room:recognitionSchema.properties.rooms.items}}},
 footprints:{type:'array',maxItems:5,items:{type:'object',required:['floorIndex','footprint'],properties:{floorIndex:{type:'integer'},footprint:recognitionSchema.properties.footprint}}},
 warnings:{type:'array',maxItems:10,items:{type:'string',maxLength:1000}}
}}
/** Applies a bounded repair without allowing omitted floors, walls, rooms or smaller openings. */
export function applyModelCorrection(previous:any,patch:any){
 if(!previous||!Array.isArray(previous.floors)||!patch||!['walls','rooms','footprints','warnings'].every(k=>Array.isArray(patch[k]))||patch.walls.length>100||patch.rooms.length>100||patch.footprints.length>5||patch.warnings.length>10||patch.warnings.some((s:any)=>typeof s!=='string'||s.length>1000))throw new Error('Incomplete model correction.')
 const next=structuredClone(previous),seen=new Set<string>()
 const target=(p:any,kind:string,index:number)=>{const key=`${p.floorIndex}:${kind}:${index}`;if(!Number.isInteger(p.floorIndex)||p.floorIndex<0||!next.floors[p.floorIndex]?.plan||seen.has(key))throw new Error('Invalid or duplicated correction target.');seen.add(key);return next.floors[p.floorIndex].plan}
 for(const p of patch.walls){
  const plan=target(p,'wall',p.wallIndex),old=plan.walls?.[p.wallIndex]
  if(!Number.isInteger(p.wallIndex)||p.wallIndex<0||!old||!p.wall||!Array.isArray(p.wall.openings))throw new Error('A correction removed or resized a printed opening. The model was not replaced.')
  plan.walls[p.wallIndex]=p.wall
 }
 const openings=(f:any)=>JSON.stringify(f.plan.walls.flatMap((w:any)=>w.openings.map((o:any)=>JSON.stringify([o.kind,o.width,o.height]))).sort())
 if(next.floors.some((f:any,i:number)=>openings(f)!==openings(previous.floors[i])))throw new Error('A correction removed or resized a printed opening. The model was not replaced.')
 for(const p of patch.rooms){const plan=target(p,'room',p.roomIndex);if(!Number.isInteger(p.roomIndex)||p.roomIndex<0||!plan.rooms?.[p.roomIndex]||p.room?.name!==plan.rooms[p.roomIndex].name)throw new Error('Invalid room correction.');plan.rooms[p.roomIndex]=p.room}
 for(const p of patch.footprints){const plan=target(p,'footprint',0);if(!Array.isArray(p.footprint))throw new Error('Invalid footprint correction.');plan.footprint=p.footprint}
 next.warnings=Array.from(new Set([...(next.warnings||[]),...patch.warnings])).slice(-40)
 return next
}
