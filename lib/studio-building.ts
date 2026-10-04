import {allRooms,allWalls,geometryBounds,levels,length,pointInside,simplePolygon,validOpening} from './studio-geometry.ts'
import type {Geometry,FloorGeometry} from './studio-geometry.ts'
const num=(v:unknown,min:number,max:number):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max
const str=(v:unknown,max=500):v is string=>typeof v==='string'&&v.length<=max
const colour=(v:unknown)=>typeof v==='string'&&/^#[a-f\d]{6}$/i.test(v)
const point=(p:any)=>p&&num(p.x,-20000,20000)&&num(p.y,-20000,20000)
export function validBuilding(input:unknown):input is Geometry {
  try {
    const g=input as Geometry
    if(!g||g.storeys&&(!Array.isArray(g.storeys)||g.storeys.length>4||g.storeys.some(s=>!s||!str(s.id,100)||s.id==='ground'||!str(s.name,100)||!num(s.elevation,.2,30)||!s.geometry||'storeys' in s.geometry)))return false
    if(new Set(levels(g).map(l=>l.id)).size!==levels(g).length)return false
    for(const l of levels(g)){
      const f=l.geometry
      if(!Array.isArray(f.footprint)||!f.footprint.every(point)||!simplePolygon(f.footprint)||!str(f.source,1000)||typeof f.verified!=='boolean'||!Array.isArray(f.walls)||f.walls.length>150)return false
      if(!f.walls.every(w=>w&&str(w.id,100)&&str(w.name)&&str(w.note,4000)&&point(w.a)&&point(w.b)&&length(w.a,w.b)>.05&&num(w.height,.5,12)&&num(w.thickness,.05,1)&&(w.colour===undefined||colour(w.colour))&&Array.isArray(w.openings)&&w.openings.length<=30&&new Set(w.openings.map(o=>o.id)).size===w.openings.length&&w.openings.every(o=>str(o.id,100)&&['door','window'].includes(o.kind)&&validOpening(w,o))))return false
      if(f.rooms&&(!Array.isArray(f.rooms)||f.rooms.length>80||f.rooms.some(r=>!str(r.id,100)||!str(r.name,200)||!['oak','tile','concrete','carpet'].includes(r.finish)||!['none','living','bedroom','dining','kitchen-island','kitchen-wall','lift'].includes(r.furniture)||!Array.isArray(r.polygon)||!r.polygon.every(point)||!simplePolygon(r.polygon)||!r.polygon.every(p=>pointInside(p,f.footprint)))))return false
      if(f.roof&&(!['none','flat','gable'].includes(f.roof.style)||!num(f.roof.pitch,0,60)||!num(f.roof.overhang,0,2)||!['x','y'].includes(f.roof.axis)||!colour(f.roof.colour)))return false
      if(f.checks&&(!Array.isArray(f.checks)||f.checks.length>100||new Set(f.checks.map(m=>m.id)).size!==f.checks.length||f.checks.some(m=>!str(m.id,100)||!str(m.label,200)||!str(m.source,1000)||!point(m.a)||!point(m.b)||!num(m.expected,.01,100)||!num(m.tolerance,0,1))))return false
    }
    const walls=allWalls(g),rooms=allRooms(g),b=geometryBounds(g)
    return b.width>=.1&&b.depth>=.1&&b.width<=100&&b.depth<=100&&new Set(walls.map(w=>w.id)).size===walls.length&&new Set(rooms.map(r=>r.id)).size===rooms.length
  }catch{return false}
}
export function publicBuilding(g:Geometry):Geometry {
  const clean=(f:FloorGeometry):FloorGeometry=>({footprint:f.footprint.map(p=>({x:p.x,y:p.y})),verified:f.verified,source:'Project geometry',walls:f.walls.map(w=>({id:w.id,name:w.name,a:{x:w.a.x,y:w.a.y},b:{x:w.b.x,y:w.b.y},height:w.height,thickness:w.thickness,note:'',...(w.colour?{colour:w.colour}:{}),openings:w.openings.map(o=>({id:o.id,kind:o.kind,offset:o.offset,width:o.width,height:o.height,sill:o.sill}))})),...(f.rooms?{rooms:f.rooms.map(r=>({id:r.id,name:r.name,polygon:r.polygon.map(p=>({x:p.x,y:p.y})),finish:r.finish,furniture:r.furniture}))}:{}),...(f.roof?{roof:{style:f.roof.style,pitch:f.roof.pitch,overhang:f.roof.overhang,axis:f.roof.axis,colour:f.roof.colour}}:{})})
  return {...clean(g),...(g.storeys?{storeys:g.storeys.map(s=>({id:s.id,name:s.name,elevation:s.elevation,geometry:clean(s.geometry)}))}:{})}
}
export function cloneFloor(f:FloorGeometry):FloorGeometry {
  const copy=structuredClone(f)
  return {...copy,verified:false,source:'Copied floor — confirm against its drawing',roof:{style:'none',pitch:25,axis:'x',overhang:.45,colour:'#535e60'},checks:[],walls:copy.walls.map(w=>({...w,id:crypto.randomUUID(),openings:w.openings.map(o=>({...o,id:crypto.randomUUID()}))})),rooms:copy.rooms?.map(r=>({...r,id:crypto.randomUUID()}))}
}

export function isolateFloorIds(g:Geometry,levelId:string,f:FloorGeometry):FloorGeometry {
 const others=levels(g).filter(l=>l.id!==levelId),walls=new Set(others.flatMap(l=>l.geometry.walls.map(w=>w.id))),rooms=new Set(others.flatMap(l=>(l.geometry.rooms||[]).map(r=>r.id)))
 return {...f,walls:f.walls.map(w=>walls.has(w.id)?{...w,id:crypto.randomUUID()}:w),rooms:f.rooms?.map(r=>rooms.has(r.id)?{...r,id:crypto.randomUUID()}:r)}
}
