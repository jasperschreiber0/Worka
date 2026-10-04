export type Point = { x: number; y: number }
export type Opening = { id: string; kind: 'door' | 'window'; offset: number; width: number; height: number; sill: number }
export type Wall = { id: string; name: string; a: Point; b: Point; height: number; thickness: number; openings: Opening[]; note: string; colour?:string }
export type Room = {id:string;name:string;polygon:Point[];finish:'oak'|'tile'|'concrete'|'carpet';furniture:'none'|'living'|'bedroom'|'dining'|'kitchen-island'|'kitchen-wall'|'lift'}
export type Roof = {style:'none'|'flat'|'gable';pitch:number;overhang:number;axis:'x'|'y';colour:string}
export type Measurement = {id:string;label:string;a:Point;b:Point;expected:number;tolerance:number;source:string}
export type FloorGeometry = { footprint: Point[]; walls: Wall[]; verified: boolean; source: string; rooms?:Room[]; roof?:Roof; checks?:Measurement[] }
export type Storey = {id:string;name:string;elevation:number;geometry:FloorGeometry}
export type Geometry = FloorGeometry & {storeys?:Storey[]}
export function levels(g:Geometry):Storey[]{const {storeys,...base}=g;return [{id:'ground',name:'Ground floor',elevation:0,geometry:base},...(storeys||[])]}
export const allWalls=(g:Geometry)=>levels(g).flatMap(l=>l.geometry.walls)
export const floorArea=(g:Geometry)=>levels(g).reduce((s,l)=>s+polygonArea(l.geometry.footprint),0)
export const allRooms=(g:Geometry)=>levels(g).flatMap(l=>l.geometry.rooms||[])
export const measurementError=(m:Measurement)=>Math.abs(length(m.a,m.b)-m.expected)
export const unresolvedChecks=(g:Geometry)=>levels(g).flatMap(l=>(l.geometry.checks||[]).filter(m=>measurementError(m)>m.tolerance+.000001))
export function replaceLevel(g:Geometry,id:string,next:FloorGeometry):Geometry {
  return id==='ground'?{...next,storeys:g.storeys}:{...g,storeys:g.storeys?.map(l=>l.id===id?{...l,geometry:next}:l)}
}
export function buildingDimensions(g:Geometry){const b=geometryBounds(g);return {width:Math.round(b.width*100)/100,depth:Math.round(b.depth*100)/100,height:Math.max(...allWalls(g).map(w=>w.height),2.7),geometry:g}}
export function resizeLevel(g:FloorGeometry,xScale:number,yScale:number):FloorGeometry {
  const b=geometryBounds(g),point=(p:Point)=>({x:b.minX+(p.x-b.minX)*xScale,y:b.minY+(p.y-b.minY)*yScale})
  return {...g,verified:false,footprint:g.footprint.map(point),rooms:g.rooms?.map(r=>({...r,polygon:r.polygon.map(point)})),checks:g.checks?.map(m=>({...m,a:point(m.a),b:point(m.b)})),walls:g.walls.map(w=>{const a=point(w.a),b=point(w.b),ratio=length(a,b)/length(w.a,w.b);return {...w,a,b,openings:w.openings.map(o=>({...o,offset:o.offset*ratio,width:o.width*ratio}))}})}
}
export function roofArea(g:FloorGeometry){const r=g.roof;if(!r||r.style==='none')return 0;const b=geometryBounds(g);return r.style==='gable'?(b.width+2*r.overhang)*(b.depth+2*r.overhang)/Math.cos(r.pitch*Math.PI/180):polygonArea(g.footprint)}
export function pointInside(p:Point,polygon:Point[]){let inside=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if(Math.abs((p.x-a.x)*(b.y-a.y)-(p.y-a.y)*(b.x-a.x))<1e-8&&p.x>=Math.min(a.x,b.x)&&p.x<=Math.max(a.x,b.x)&&p.y>=Math.min(a.y,b.y)&&p.y<=Math.max(a.y,b.y))return true;if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside}return inside}
export const length = (a: Point, b: Point) => Math.hypot(b.x-a.x,b.y-a.y)
export function polygonArea(points: Point[]) { return Math.abs(points.reduce((s,p,i)=>{const q=points[(i+1)%points.length];return s+p.x*q.y-q.x*p.y},0))/2 }
export function polygonPerimeter(points: Point[]) { return points.reduce((s,p,i)=>s+length(p,points[(i+1)%points.length]),0) }
export function wallArea(wall: Wall) { return Math.max(0,length(wall.a,wall.b)*wall.height-wall.openings.reduce((s,o)=>s+o.width*o.height,0)) }
export function validOpening(wall: Wall, o: Opening) {
  return Number.isFinite(o.offset+o.width+o.height+o.sill) && o.offset>=0 && o.width>.05 && o.height>.05 && o.sill>=0 && o.offset+o.width<=length(wall.a,wall.b)+.001 && o.sill+o.height<=wall.height+.001 && !wall.openings.some(other=>other.id!==o.id && o.offset<other.offset+other.width-.001 && o.offset+o.width>other.offset+.001)
}
export function simplePolygon(points: Point[]) {
  if(points.length<3 || points.length>100 || polygonArea(points)<.1)return false
  const cross=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)
  for(let i=0;i<points.length;i++) {
    const a=points[i],b=points[(i+1)%points.length]
    if(length(a,b)<.01)return false
    for(let j=i+1;j<points.length;j++) {
      if(j===i+1 || (i===0 && j===points.length-1))continue
      const c=points[j],d=points[(j+1)%points.length]
      if(cross(a,b,c)*cross(a,b,d)<=0 && cross(c,d,a)*cross(c,d,b)<=0 && Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x))<=Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x)) && Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y))<=Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y)))return false
    }
  }
  return true
}
export function rectangleGeometry(width:number,depth:number,height:number):Geometry {
  const footprint=[{x:0,y:0},{x:width,y:0},{x:width,y:depth},{x:0,y:depth}]
  return {footprint,verified:false,source:'Entered dimensions',walls:footprint.map((a,i)=>({id:'wall-'+i,name:['North wall','East wall','South wall','West wall'][i],a,b:footprint[(i+1)%4],height,thickness:.15,openings:[],note:''}))}
}
export function geometryBounds(g:Geometry) {
  const points=levels(g).flatMap(l=>[...l.geometry.footprint,...l.geometry.walls.flatMap(w=>[w.a,w.b])])
  return {minX:Math.min(...points.map(p=>p.x)),minY:Math.min(...points.map(p=>p.y)),width:Math.max(...points.map(p=>p.x))-Math.min(...points.map(p=>p.x)),depth:Math.max(...points.map(p=>p.y))-Math.min(...points.map(p=>p.y))}
}
