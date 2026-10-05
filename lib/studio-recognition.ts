import { geometryBounds, length, simplePolygon, validOpening, pointInside } from './studio-geometry.ts'
import type { Geometry, Point, Wall } from './studio-geometry.ts'
import {validBuilding} from './studio-building.ts'

// The vision model returns image coordinates, never trusted application geometry.
export function recognisedPlan(input: unknown, aspect: number, suppliedScale = 0, source = 'Uploaded plan') {
  const raw = input as any
  // A closed ring repeats its first point. Removing that final duplicate changes
  // no edge or area, and accepts the normal GIS representation without guessing.
  const ring=(points:any)=>Array.isArray(points)&&points.length>3&&points[0]?.x===points.at(-1)?.x&&points[0]?.y===points.at(-1)?.y?points.slice(0,-1):points
  const v=raw?{...raw,footprint:ring(raw.footprint),rooms:Array.isArray(raw.rooms)?raw.rooms.map((r:any)=>({...r,polygon:ring(r.polygon)})):raw.rooms}:raw
  const number = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max
  const point = (p: any): p is Point => p && number(p.x, 0, 1000) && number(p.y, 0, 1000 / aspect)
  if (!v || !number(aspect, .05, 20) || !Array.isArray(v.warnings) || v.warnings.length > 30 || !v.warnings.every((s: unknown) => typeof s === 'string' && s.length <= 500)) throw new Error('The drawing response was incomplete. Try a clearer floor-plan page.')
  if (v.kind !== 'floor-plan') throw new Error('Choose a floor-plan page showing the walls. Elevations, site plans and photographs cannot be reconstructed with this tool yet.')
  let scale = suppliedScale
  if (!scale) {
    let d = v.dimension
    if(!d&&Array.isArray(v.dimensions)){
      const candidates=v.dimensions.filter((c:any)=>point(c.a)&&point(c.b)&&number(c.metres,.01,100)&&length(c.a,c.b)>=10)
      // Require independent spans, not repeated copies of one dimension.
      const unique=candidates.filter((c:any,i:number)=>!candidates.slice(0,i).some((p:any)=>(length(c.a,p.a)<1&&length(c.b,p.b)<1)||(length(c.a,p.b)<1&&length(c.b,p.a)<1)))
      if(unique.length>=2){const scales:number[]=unique.map((c:any)=>c.metres/length(c.a,c.b));const median=[...scales].sort((a,b)=>a-b)[Math.floor(scales.length/2)];if(scales.some(s=>Math.abs(s/median-1)>.03))throw new Error('Printed dimension checks disagree on scale. Check the selected floor plan or calibrate a known dimension.');d=unique.sort((a:any,b:any)=>length(b.a,b.b)-length(a.a,a.b))[0]}
    }
    if (!d || !point(d.a) || !point(d.b) || !number(d.metres, .01, 100) || length(d.a, d.b) < 10) throw new Error('No readable dimension was found. Set the scale using a known dimension below, then generate again.')
    scale = d.metres / length(d.a, d.b)
    if(Array.isArray(v.dimensions)&&v.dimensions.some((c:any)=>point(c.a)&&point(c.b)&&number(c.metres,.01,100)&&length(c.a,c.b)>=10&&Math.abs((c.metres/length(c.a,c.b))/scale-1)>.03))throw new Error('Printed dimension checks disagree on scale. Check the selected floor plan or calibrate a known dimension.')
  }
  if (!number(scale, .00001, 1) || !Array.isArray(v.footprint) || !v.footprint.every(point) || !simplePolygon(v.footprint) || !Array.isArray(v.walls) || v.walls.length < 3 || v.walls.length > 150) throw new Error('The detected footprint was not usable. Choose a clearer floor-plan page or trace it manually.')
  const convert = (p: Point) => ({ x: p.x * scale, y: p.y * scale })
  const prefix = globalThis.crypto.randomUUID()
  const openingIssues:string[]=[]
  const walls: Wall[] = v.walls.map((w: any, i: number) => {
    if (!point(w.a) || !point(w.b) || typeof w.name !== 'string' || w.name.length > 200 || !number(w.height, .5, 12) || !number(w.thickness, .05, 1) || !Array.isArray(w.openings) || w.openings.length > 30) throw new Error('A detected wall had invalid measurements. Nothing has been replaced.')
    const wall: Wall = { id: `${prefix}-${i}`, name: w.name, a: convert(w.a), b: convert(w.b), height: w.height, thickness: w.thickness, note: 'AI draft: check location, height and openings against the drawing.', openings: w.openings.map((o: any, j: number) => {
      if (!['door', 'window'].includes(o.kind) || !number(o.offset, 0, 100) || !number(o.width, .051, 100) || !number(o.height, .051, 12) || !number(o.sill, 0, 12)) throw new Error('A detected opening had invalid dimensions.')
      let offset=o.offset
      if(o.center!==undefined){
        if(!point(o.center))throw new Error('An opening centre is outside the drawing.')
        const a=convert(w.a),b=convert(w.b),c=convert(o.center),span=length(a,b),dx=(b.x-a.x)/span,dy=(b.y-a.y)/span
        if(!Number.isFinite(span)||span<.1)throw new Error('An opening is assigned to a wall with no usable length.')
        const separation=Math.abs((c.x-a.x)*dy-(c.y-a.y)*dx)
        if(separation>Math.max(.3,w.thickness))openingIssues.push(`An opening centre does not lie on its assigned wall: wall ${i} (${w.name}), opening ${j}, center ${JSON.stringify(o.center)}, wall endpoints ${JSON.stringify(w.a)} to ${JSON.stringify(w.b)}, perpendicular separation ${separation.toFixed(3)} m. Re-read the assigned wall and gap in the drawing; preserve printed opening size.`)
        offset=(c.x-a.x)*dx+(c.y-a.y)*dy-o.width/2
      }
      return { id: `${prefix}-${i}-${j}`, kind: o.kind, offset, width: o.width, height: o.height, sill: o.sill }
    }) }
    if (length(wall.a, wall.b) < .1 || !wall.openings.every(o => validOpening(wall, o))) openingIssues.push('Invalid openings on wall '+i+' ('+w.name+'): wall length '+length(wall.a,wall.b).toFixed(3)+' m, wall height '+wall.height+' m; openings '+JSON.stringify(wall.openings.map(o=>({kind:o.kind,offset:o.offset,width:o.width,height:o.height,sill:o.sill})))+'. Openings must fit horizontally and vertically without overlap.')
    return wall
  })
  const geometry: Geometry = { footprint: v.footprint.map(convert), walls, verified: false, source }
  if(v.rooms!==undefined){
    if(!Array.isArray(v.rooms)||v.rooms.length>80)throw new Error('The detected rooms were incomplete.')
    geometry.rooms=v.rooms.map((r:any,i:number)=>{if(typeof r.name!=='string'||r.name.length>200||!Array.isArray(r.polygon)||!r.polygon.every(point))throw new Error('A detected room has invalid boundaries.');return {id:prefix+'-room-'+i,name:r.name,polygon:r.polygon.map(convert),finish:'oak',furniture:'none'}})
    for(const [index,room] of Array.from(geometry.rooms!.entries())){
      if(!simplePolygon(room.polygon))openingIssues.push(`Room ${index} (${room.name}) has a crossed, repeated or degenerate polygon. Trace its actual boundary in order without removing the room.`)
      const outside=v.rooms[index].polygon.filter((p:Point)=>!pointInside(p,v.footprint))
      if(outside.length)openingIssues.push(`Room ${index} (${room.name}) extends outside the floor footprint at image points ${JSON.stringify(outside.slice(0,6))}. Re-read the footprint and room outline; preserve the room and correct its actual boundary.`)
    }
  }
  if(openingIssues.length)throw new Error(openingIssues.join('\n'))
  if(v.dimensions!==undefined){
    if(!Array.isArray(v.dimensions)||v.dimensions.length>100)throw new Error('Too many dimension checks in this response.')
    geometry.checks=v.dimensions.map((d:any,i:number)=>{if(!point(d.a)||!point(d.b)||!number(d.metres,.01,100)||typeof d.label!=='string'||d.label.length>200)throw new Error('A dimension check was incomplete.');return {id:prefix+'-check-'+i,label:d.label,a:convert(d.a),b:convert(d.b),expected:d.metres,tolerance:.05,source}})
  }
  const bounds = geometryBounds(geometry)
  if (!simplePolygon(geometry.footprint) || bounds.width < .1 || bounds.depth < .1 || bounds.width > 100 || bounds.depth > 100) throw new Error('The drawing scale produced implausible dimensions. Set a known dimension and try again.')
  if(!validBuilding(geometry))throw new Error('Detected room or wall geometry was invalid. Nothing has been replaced.')
  return { geometry, metresPerUnit: scale, warnings: ['AI draft — check every dimension and opening before using quantities.', 'Wall heights and opening sizes may be assumed where the plan does not specify them.', ...v.warnings], design: { width: Math.round(bounds.width * 100) / 100, depth: Math.round(bounds.depth * 100) / 100, height: Math.max(...walls.map(w => w.height)), geometry } }
}


const pointSchema={type:'object',required:['x','y'],properties:{x:{type:'number'},y:{type:'number'}}}
const dimensionSchema={type:'object',required:['label','a','b','metres'],properties:{label:{type:'string'},a:pointSchema,b:pointSchema,metres:{type:'number'}}}
export const recognitionSchema={
 type:'object',required:['kind','dimension','footprint','walls','warnings','rooms','dimensions'],
 properties:{
  kind:{type:'string',enum:['floor-plan','unsupported']},
  dimension:{type:['object','null'],properties:{a:pointSchema,b:pointSchema,metres:{type:'number'}}},
  footprint:{type:'array',items:pointSchema},
  rooms:{type:'array',items:{type:'object',required:['name','polygon'],properties:{name:{type:'string'},polygon:{type:'array',items:pointSchema}}}},
  dimensions:{type:'array',items:dimensionSchema},
  walls:{type:'array',items:{type:'object',required:['name','a','b','height','thickness','openings'],properties:{name:{type:'string'},a:pointSchema,b:pointSchema,height:{type:'number'},thickness:{type:'number'},openings:{type:'array',items:{type:'object',required:['kind','center','offset','width','height','sill'],properties:{center:pointSchema,kind:{type:'string',enum:['door','window']},offset:{type:'number'},width:{type:'number'},height:{type:'number'},sill:{type:'number'}}}}}}},
  warnings:{type:'array',items:{type:'string'}}
 }
}
