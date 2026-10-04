'use client'

import { useRef, useState } from 'react'
import { Maximize, Minus, Plus, RotateCcw } from 'lucide-react'
import type { Design } from '@/lib/project-studio'

type Point = [number, number, number]
type Face = { vertices: Point[]; colour: string; stroke?: string }
function box(x: number, y: number, z: number, w: number, d: number, h: number, colour: string): Face[] {
  const p: Point[] = [[x,y,z],[x+w,y,z],[x+w,y+d,z],[x,y+d,z],[x,y,z+h],[x+w,y,z+h],[x+w,y+d,z+h],[x,y+d,z+h]]
  return [[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7],[4,5,6,7]].map((indices, i) => ({ vertices: indices.map(j => p[j]), colour, stroke: i === 4 ? '#ffffff65' : '#34464b28' }))
}

export default function PlanModel({ design, small = false }: { design: Design; small?: boolean }) {
  const [angle, setAngle] = useState(-0.66)
  const [tilt, setTilt] = useState(0.73)
  const [zoom, setZoom] = useState(1)
  const [top, setTop] = useState(false)
  const [walls, setWalls] = useState(false)
  const [labels, setLabels] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const drag = useRef<{ x: number; y: number; a: number; t: number } | null>(null)
  const { width: w, depth: d, height: h } = design
  const rotation = top ? 0 : angle, elevation = top ? Math.PI / 2 : tilt
  const project = ([x,y,z]: Point) => {
    const a = x - w/2, b = y - d/2
    const rx = a*Math.cos(rotation)-b*Math.sin(rotation)
    const ry = a*Math.sin(rotation)+b*Math.cos(rotation)
    return { x: 450+rx*58*zoom, y: 310+(ry*Math.sin(elevation)-z*Math.cos(elevation))*58*zoom, depth: ry*Math.cos(elevation)+z*Math.sin(elevation) }
  }
  const faces: Face[] = []
  faces.push(...box(-0.6,-0.6,-0.25,w+1.2,d+1.2,0.1,'#cdd9cf'))
  faces.push(...box(0,0,-0.15,w,d,0.15,'#c2b7a5'))
  // Illustrative furnishings. Outside dimensions drive the linked estimate.
  faces.push(...box(0,0,0,w/2,d,0.025,'#e8d8bf'))
  faces.push(...box(w/2,0,0,w/2,2.5,0.025,'#eee7da'))
  faces.push(...box(w/2,2.5,0,w/2,d-2.5,0.025,'#e5d2b5'))
  const wallHeight = walls ? h : 0.65
  faces.push(...box(0,0,0,w,0.14,wallHeight,'#f9f6ef'))
  faces.push(...box(0,0,0,0.14,d,wallHeight,'#f9f6ef'))
  faces.push(...box(w-0.14,0,0,0.14,0.7,wallHeight,'#ede8dd'))
  faces.push(...box(w-0.14,2.1,0,0.14,d-2.1,wallHeight,'#ede8dd'))
  if (walls) {
    faces.push(...box(w-0.14,0.7,0,0.14,1.4,0.9,'#ede8dd'))
    faces.push(...box(w-0.14,0.7,2.1,0.14,1.4,h-2.1,'#ede8dd'))
    faces.push(...box(w-0.1,0.7,0.9,0.035,1.4,1.2,'#9bc9d3'))
  }
  faces.push(...box(0,d-0.14,0,1.3,0.14,wallHeight,'#f5f1e8'))
  faces.push(...box(w/2+0.6,d-0.14,0,w/2-0.6,0.14,wallHeight,'#f5f1e8'))
  if (walls) {
    faces.push(...box(1.3,d-0.14,2.2,w/2-0.7,0.14,h-2.2,'#f5f1e8'))
    faces.push(...box(1.3,d-0.1,0,0.04,0.04,2.2,'#344e54'))
    faces.push(...box(w/2+0.56,d-0.1,0,0.04,0.04,2.2,'#344e54'))
  }
  faces.push(...box(w/2+0.15,0.2,0,w/2-0.4,0.6,0.85,'#647b70'))
  faces.push(...box(w/2+0.13,0.18,0.85,w/2-0.36,0.64,0.05,'#fcf9f1'))
  faces.push(...box(w/2+0.7,1.45,0,1.9,0.8,0.85,'#73877b'))
  faces.push(...box(w/2+0.65,1.4,0.85,2,0.9,0.06,'#fffaf2'))
  faces.push(...box(0.45,0.5,0,2.5,0.9,0.45,'#a8b8ae'))
  faces.push(...box(0.45,0.45,0.45,2.5,0.22,0.35,'#8fa498'))
  faces.push(...box(0.42,0.48,0.4,0.2,0.95,0.24,'#8fa498'))
  faces.push(...box(2.76,0.48,0.4,0.2,0.95,0.24,'#8fa498'))
  faces.push(...box(1,1.9,0,1.5,0.7,0.35,'#bd9b70'))
  faces.push(...box(w/2+0.8,3.5,0.67,2,1.05,0.1,'#ba9870'))
  for (const x of [w/2+0.87,w/2+2.65]) for (const y of [3.58,4.4]) faces.push(...box(x,y,0,0.1,0.1,0.67,'#8a775b'))
  for (const x of [w/2+1,w/2+2]) for (const y of [2.95,4.7]) {
    faces.push(...box(x,y,0.38,0.5,0.48,0.12,'#c5a986'))
    faces.push(...box(x,y+(y<4 ? 0 : 0.4),0.45,0.5,0.08,0.4,'#c5a986'))
  }
  // Ground/slab/floor planes must render beneath all furnishings. Sorting these
  // large planes by centroid together with furniture incorrectly hides far objects.
  const projected = faces.map(face => ({ ...face, points: face.vertices.map(project), depth: face.vertices.reduce((s,p)=>s+project(p).depth,0)/face.vertices.length }))
  const sorted = [...projected.slice(0,25), ...projected.slice(25).sort((a,b)=>a.depth-b.depth)]
  const textAt = (point: Point, label: string, sub?: string) => {
    const p = project(point)
    return <g key={label} transform={'translate('+p.x+' '+p.y+')'} className="studio-room-label"><rect x={-70} y={-18} width={140} height={sub ? 44 : 30} rx={8} fill="#fffdf5ee" stroke="#d8dfd8"/><text textAnchor="middle" y={2} fill="#24443c" fontSize={13} fontWeight={650}>{label}</text>{sub && <text textAnchor="middle" y={18} fill="#52655f" fontSize={11}>{sub}</text>}</g>
  }
  const dimension = (a: Point,b: Point,label: string) => {
    const pa=project(a),pb=project(b)
    return <g key={label}><line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke="#4b6a5e" strokeWidth={1.3}/>{[pa,pb].map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={3} fill="#4b6a5e"/>)}<text x={(pa.x+pb.x)/2} y={(pa.y+pb.y)/2+18} textAnchor="middle" fontSize={13} fontWeight={600} fill="#325347" stroke="#f0f3ec" strokeWidth={5} paintOrder="stroke">{label}</text></g>
  }
  function reset() { setAngle(-0.66); setTilt(0.73); setZoom(1); setTop(false) }
  return <div className={'studio-model '+(small ? 'small ' : '')+(expanded ? 'expanded' : '')}>
    <div className="studio-model-top"><span className="studio-tag">{top ? '2D floor plan' : '3D concept'} · {walls ? h+' m walls' : 'Cutaway'}</span><div className="studio-segment"><button type="button" aria-pressed={!top} onClick={()=>setTop(false)}>3D</button><button type="button" aria-pressed={top} onClick={()=>setTop(true)}>Plan</button></div></div>
    <svg viewBox="0 0 900 620" role="img" aria-label={'Conceptual '+w+' by '+d+' metre extension, '+(w*d)+' square metres. Drag to rotate.'} tabIndex={0}
      onPointerDown={e=>{ if(top) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current={x:e.clientX,y:e.clientY,a:angle,t:tilt} }}
      onPointerMove={e=>{if(drag.current){setAngle(drag.current.a+(e.clientX-drag.current.x)*0.008);setTilt(Math.max(0.25,Math.min(1.4,drag.current.t+(e.clientY-drag.current.y)*0.005)))}}}
      onPointerUp={()=>{drag.current=null}} onPointerCancel={()=>{drag.current=null}}
      onKeyDown={e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();setTop(false);if(e.key==='ArrowLeft')setAngle(a=>a-0.15);if(e.key==='ArrowRight')setAngle(a=>a+0.15);if(e.key==='ArrowUp')setTilt(t=>Math.min(1.4,t+0.1));if(e.key==='ArrowDown')setTilt(t=>Math.max(0.25,t-0.1))}}}>
      <defs><pattern id="studio-grid" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M 36 0 L 0 0 0 36" fill="none" stroke="#cbd6cb" strokeWidth="0.7"/></pattern></defs>
      <rect width="900" height="620" fill="url(#studio-grid)" opacity="0.5"/>
      {sorted.map((face,i)=><polygon key={i} points={face.points.map(p=>p.x+','+p.y).join(' ')} fill={face.colour} stroke={face.stroke || '#61706730'} strokeWidth={0.7} strokeLinejoin="round"/>)}
      {dimension([0,d+0.65,0],[w,d+0.65,0],w.toFixed(1)+' m')}
      {dimension([w+0.65,0,0],[w+0.65,d,0],d.toFixed(1)+' m')}
      {labels && <>{textAt([w/4,3.9,0.06],'Living',(w/2*d).toFixed(1)+' m² zone')}{textAt([w*0.75,1,1.1],'Kitchen')}{textAt([w*0.75,5.4,0.06],'Dining')}</>}
    </svg>
    <div className="studio-model-bottom"><span>{top ? 'Gross footprint · external dimensions' : 'Drag or use arrow keys to orbit'}</span><div className="studio-tools"><button type="button" aria-label="Zoom out" onClick={()=>setZoom(z=>Math.max(0.65,z-0.1))}><Minus size={16}/></button><button type="button" aria-label="Zoom in" onClick={()=>setZoom(z=>Math.min(1.35,z+0.1))}><Plus size={16}/></button><button type="button" aria-label="Reset view" onClick={reset}><RotateCcw size={16}/></button><button type="button" aria-label={expanded ? 'Exit expanded view' : 'Expand view'} onClick={()=>setExpanded(v=>!v)}><Maximize size={16}/></button></div></div>
    {!small && <div className="studio-model-options"><label><input type="checkbox" checked={walls} onChange={e=>setWalls(e.target.checked)}/>Full-height walls</label><label><input type="checkbox" checked={labels} onChange={e=>setLabels(e.target.checked)}/>Room labels</label><span>Roof omitted for visibility</span></div>}
  </div>
}
