const point={type:'object',required:['x','y'],properties:{x:{type:'number'},y:{type:'number'}}}
const polygon={type:'array',maxItems:100,items:point}
export const floorPositionSchema={type:'object',required:['walls','openings','rooms','footprint','warnings'],properties:{
 walls:{type:'array',maxItems:150,items:{type:'object',required:['wallIndex','a','b','height'],properties:{wallIndex:{type:'integer'},a:point,b:point,height:{type:'number'}}}},
 openings:{type:'array',maxItems:300,items:{type:'object',required:['wallIndex','openingIndex','targetWallIndex','center','sill'],properties:{wallIndex:{type:'integer'},openingIndex:{type:'integer'},targetWallIndex:{type:'integer'},center:point,sill:{type:'number'}}}},
 rooms:{type:'array',maxItems:80,items:{type:'object',required:['roomIndex','polygon'],properties:{roomIndex:{type:'integer'},polygon}}},
 footprint:polygon,warnings:{type:'array',maxItems:30,items:{type:'string',maxLength:500}},
}}
/** Repairs placement without asking the model to copy immutable opening sizes. */
export function repairFloorPositions(previous:any,patch:any){
 const validPoint=(p:any)=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1000&&p.y>=0&&p.y<=20000
 const validPolygon=(p:any)=>Array.isArray(p)&&p.length<=100&&p.every(validPoint)
 if(!patch||!['walls','openings','rooms','footprint','warnings'].every(k=>Array.isArray(patch[k]))||patch.walls.length>150||patch.openings.length>300||patch.rooms.length>80||!validPolygon(patch.footprint)||patch.warnings.length>30||patch.warnings.some((s:any)=>typeof s!=='string'||s.length>500))throw new Error('Incomplete position correction. Saved geometry is unchanged.')
 const next=structuredClone(previous),plan=next.floors[0].plan,old=previous.floors[0].plan,seen=new Set<string>()
 const index=(n:any,count:number,key:string)=>{if(!Number.isInteger(n)||n<0||n>=count||seen.has(key+':'+n))throw new Error('Invalid or repeated correction target.');seen.add(key+':'+n)}
 for(const w of patch.walls){index(w.wallIndex,plan.walls.length,'wall');if(!validPoint(w.a)||!validPoint(w.b)||!Number.isFinite(w.height)||w.height<.5||w.height>12)throw new Error('Invalid corrected wall.');Object.assign(plan.walls[w.wallIndex],{a:w.a,b:w.b,height:w.height})}
 const moved=new Set<string>(),additions:{wallIndex:number;opening:any}[]=[]
 for(const o of patch.openings){
  if(!Number.isInteger(o.wallIndex)||!old.walls[o.wallIndex]||!Number.isInteger(o.targetWallIndex)||!plan.walls[o.targetWallIndex])throw new Error('Invalid opening wall.')
  index(o.openingIndex,old.walls[o.wallIndex].openings.length,'opening:'+o.wallIndex)
  if(!validPoint(o.center)||!Number.isFinite(o.sill)||o.sill<0||o.sill>12)throw new Error('Invalid opening position.')
  moved.add(o.wallIndex+':'+o.openingIndex)
  additions.push({wallIndex:o.targetWallIndex,opening:{...old.walls[o.wallIndex].openings[o.openingIndex],center:o.center,offset:0,sill:o.sill}})
 }
 for(let i=0;i<plan.walls.length;i++)plan.walls[i].openings=plan.walls[i].openings.filter((_:any,j:number)=>!moved.has(i+':'+j))
 for(const a of additions)plan.walls[a.wallIndex].openings.push(a.opening)
 for(const r of patch.rooms){index(r.roomIndex,plan.rooms.length,'room');if(!validPolygon(r.polygon)||r.polygon.length<3)throw new Error('Invalid room polygon.');plan.rooms[r.roomIndex].polygon=r.polygon}
 if(patch.footprint.length){if(patch.footprint.length<3)throw new Error('Invalid footprint.');plan.footprint=patch.footprint}
 plan.warnings=[...plan.warnings,...patch.warnings].slice(-30)
 return next
}
