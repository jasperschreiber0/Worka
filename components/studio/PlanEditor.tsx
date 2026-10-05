'use client'
import {vectorDimensions} from '@/lib/studio-vector-scale'

import { useRef,useState } from 'react'
import {drawingText} from '@/lib/studio-drawing-text'
import AutomaticPlan from './AutomaticPlan'
import type { Workspace,PlanSource } from '@/lib/studio-workspace'
import { uid } from '@/lib/studio-workspace'
import { revise,round } from '@/lib/project-studio'
import { geometryBounds,length,polygonArea,rectangleGeometry,simplePolygon,validOpening,wallArea } from '@/lib/studio-geometry'
import type { Geometry,Point,Wall,Opening } from '@/lib/studio-geometry'

export function Numeric({value,label,onChange,min=0,max=1000000,step=.01}:{value:number;label:string;onChange:(n:number)=>void;min?:number;max?:number;step?:number}) {
  return <input key={value} aria-label={label} type="number" defaultValue={value} min={min} max={max} step={step} onBlur={e=>{const n=Number(e.target.value);if(e.target.value.trim()&&Number.isFinite(n)&&n>=min&&n<=max){if(n!==value)onChange(n)}else e.target.value=String(value)}} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();if(e.key==='Escape'){e.currentTarget.value=String(value);e.currentTarget.blur()}}}/>
}
export default function PlanEditor({workspace:w,onChange,onCheckpoint,selected,onSelect}:{workspace:Workspace;onChange:(w:Workspace)=>void;onCheckpoint?:(w:Workspace)=>Promise<void>;selected:string;onSelect:(id:string)=>void}) {
  const [tool,setTool]=useState<'select'|'scale'|'footprint'|'wall'>('select'),[points,setPoints]=useState<Point[]>([]),[distance,setDistance]=useState(8),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[zoom,setZoom]=useState(1)
  const [pdfPage,setPdfPage]=useState(1),[pages,setPages]=useState(1)
  const pdf=useRef<any>(null),fileName=useRef(''),imageInput=useRef<HTMLInputElement>(null)
  const g=w.project.working.design.geometry,plan=w.plan,wall=g?.walls.find(a=>a.id===selected)
  function changeGeometry(next:Geometry,source=plan) {
    const bounds=geometryBounds(next)
    if(bounds.width<.1||bounds.depth<.1||bounds.width>100||bounds.depth>100){setMessage('Keep the traced footprint within 0.1–100 metres in each direction.');return}
    onChange({...w,plan:source,project:revise(w.project,{design:{width:round(bounds.width),depth:round(bounds.depth),height:Math.max(...next.walls.map(a=>a.height),2.7),geometry:next}})})
  }
  function updateWall(next:Wall) {
    if(!g)return
    if(length(next.a,next.b)<.1 || !next.openings.every(o=>validOpening(next,o))){setMessage('That change would put an opening outside the wall or overlap another opening.');return}
    const old=g.walls.find(a=>a.id===next.id)!
    const move=(p:Point)=>length(p,old.a)<.0001?next.a:length(p,old.b)<.0001?next.b:p
    const footprint=g.footprint.map(move),walls=g.walls.map(a=>a.id===next.id?next:{...a,a:move(a.a),b:move(a.b)})
    if(!simplePolygon(footprint)||walls.some(a=>length(a.a,a.b)<.1||!a.openings.every(o=>validOpening(a,o)))){setMessage('This would cross the footprint or put an opening outside an adjoining wall.');return}
    changeGeometry({...g,verified:false,footprint,walls,rooms:g.rooms?.map(r=>({...r,polygon:r.polygon.map(move)})),checks:g.checks?.map(m=>({...m,a:move(m.a),b:move(m.b)}))})
  }
  async function renderPage(page:number) {
    const p=await pdf.current.getPage(page),v=p.getViewport({scale:1}),view=p.getViewport({scale:Math.min(3,2600/Math.max(v.width,v.height))})
    const canvas=document.createElement('canvas');canvas.width=view.width;canvas.height=view.height
    await p.render({canvasContext:canvas.getContext('2d')!,viewport:view}).promise
    const text=await p.getTextContent().then((t:any)=>drawingText(t.items,v)).catch(()=>[])
    const vectors=await p.getOperatorList().then(async (ops:any)=>{const {resolvePDFJS}=await import('unpdf/pdfjs');return vectorDimensions(ops,(await resolvePDFJS()).OPS,(await p.getTextContent()).items,v)}).catch(()=>[])
    attach({vectorDimensions:vectors,text,name:fileName.current,page,image:canvas.toDataURL('image/jpeg',.85),aspect:canvas.width/canvas.height,metresPerUnit:0})
    setPdfPage(page)
  }
  function attach(source:PlanSource){onChange({...w,plan:source,project:g?revise(w.project,{design:{...w.project.working.design,geometry:{...g,verified:false}}}):w.project});setPoints([]);setTool('scale');setMessage(g?'New drawing attached. Existing model is retained. Calibrate, then trace a new footprint to replace it.':'Drawing ready. Choose the floor-plan page and Generate 3D, or set a scale for manual tracing.')}
  async function upload(file?:File) {
    if(!file)return
    if(file.size>20*1024*1024){setMessage('Choose a plan under 20 MB.');return}
    setBusy(true);setMessage('')
    try {
      if(file.type==='application/pdf'||file.name.toLowerCase().endsWith('.pdf')){
        const {resolvePDFJS}=await import('unpdf/pdfjs'),engine=await resolvePDFJS()
        pdf.current=await engine.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,useSystemFonts:true}).promise
        fileName.current=file.name;setPages(pdf.current.numPages);await renderPage(1)
      }else if(['image/png','image/jpeg','image/webp'].includes(file.type)){
        const bitmap=await createImageBitmap(file),canvas=document.createElement('canvas'),scale=Math.min(1,1800/Math.max(bitmap.width,bitmap.height));canvas.width=bitmap.width*scale;canvas.height=bitmap.height*scale;canvas.getContext('2d')!.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();pdf.current=null;setPages(1)
        attach({name:file.name,page:1,image:canvas.toDataURL('image/jpeg',.85),aspect:canvas.width/canvas.height,metresPerUnit:0})
      }else throw new Error('Use a PDF, PNG, JPEG or WebP. Export CAD drawings to PDF first.')
    }catch(e){setMessage(e instanceof Error?e.message:'This drawing could not be opened.')}finally{setBusy(false);if(imageInput.current)imageInput.current.value=''}
  }
  function click(e:React.MouseEvent<SVGSVGElement>){
    if(tool==='select')return
    const svg=e.currentTarget,p=svg.createSVGPoint();p.x=e.clientX;p.y=e.clientY;const local=p.matrixTransform(svg.getScreenCTM()!.inverse()),next={x:local.x,y:local.y}
    if(tool==='scale'){setPoints(p=>p.length===2?[next]:[...p,next]);return}
    if(!plan?.metresPerUnit){setMessage('Set the drawing scale first.');return}
    if(tool==='footprint'){setPoints(p=>[...p,next]);return}
    if(!g){setMessage('Trace and finish the footprint first.');return}
    if(points.length===0){setPoints([next]);return}
    const s=plan.metresPerUnit,a={x:points[0].x*s,y:points[0].y*s},b={x:next.x*s,y:next.y*s}
    if(length(a,b)<.1){setMessage('Choose wall endpoints at least 10 cm apart.');return}
    const wall:Wall={id:uid(),name:'Wall '+(g.walls.length+1),a,b,height:2.7,thickness:.15,openings:[],note:''}
    changeGeometry({...g,verified:false,walls:[...g.walls,wall]});setPoints([]);onSelect(wall.id)
  }
  function calibrate(){if(!plan||points.length!==2||length(points[0],points[1])<1||distance<=0)return;onChange({...w,plan:{...plan,metresPerUnit:distance/length(points[0],points[1]),calibration:{a:points[0],b:points[1],metres:distance}}});setPoints([]);setTool('footprint');setMessage('Trace the outside corners in order, then choose Finish footprint. Existing geometry changes only when you finish.')}
  function finish(){if(!plan)return;const s=plan.metresPerUnit,footprint=points.map(p=>({x:p.x*s,y:p.y*s}));if(!simplePolygon(footprint)){setMessage('Use at least three corners without crossing edges.');return}changeGeometry({footprint,source:plan.name+' · page '+plan.page,verified:false,walls:footprint.map((a,i)=>({id:uid(),name:'External wall '+(i+1),a,b:footprint[(i+1)%footprint.length],height:2.7,thickness:.15,openings:[],note:''}))});setPoints([]);setTool('select');setMessage('Footprint converted into walls. Select a wall to add openings and check dimensions.')}
  const scale=plan?.metresPerUnit||1,height=1000/(plan?.aspect||1)
  return <section className="wb-card"><div className="wb-card-title"><div><h2>Plan setup & measurements</h2><p>Upload a floor plan → generate a draft → check dimensions → explore in 3D.</p></div><button disabled={busy} onClick={()=>imageInput.current?.click()}>{busy?'Opening…':plan?'Replace drawing':'Upload drawing'}</button><input ref={imageInput} hidden type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={e=>void upload(e.target.files?.[0])}/></div>
    <AutomaticPlan workspace={w} onChange={onChange} onCheckpoint={onCheckpoint}/>{message&&<p role="status" className="wb-notice">{message}</p>}
    {!plan&&!g&&<div className="wb-empty"><h3>Start with your drawing or known dimensions</h3><p>Upload a floor plan to generate a draft model, or create geometry from known dimensions.</p><div className="wb-fields"><label>Width (m)<Numeric label="Footprint width" value={w.project.working.design.width} min={1} max={60} onChange={width=>onChange({...w,project:revise(w.project,{design:{...w.project.working.design,width,geometry:undefined}})})}/></label><label>Depth (m)<Numeric label="Footprint depth" value={w.project.working.design.depth} min={1} max={60} onChange={depth=>onChange({...w,project:revise(w.project,{design:{...w.project.working.design,depth,geometry:undefined}})})}/></label><button onClick={()=>changeGeometry(rectangleGeometry(w.project.working.design.width,w.project.working.design.depth,2.7))}>Create rectangular model</button></div></div>}
    {plan&&<><div className="wb-toolbar"><strong>{plan.name} · page {plan.page}</strong>{pages>1&&<label>PDF page <select aria-label="PDF page" value={pdfPage} disabled={busy} onChange={async e=>{setBusy(true);try{await renderPage(Number(e.target.value))}catch{setMessage('Unable to render that page.')}finally{setBusy(false)}}}>{Array.from({length:pages},(_,i)=><option key={i} value={i+1}>{i+1}</option>)}</select></label>}<label>Zoom <select value={zoom} onChange={e=>setZoom(Number(e.target.value))}><option value={1}>Fit</option><option value={1.5}>150%</option><option value={2}>200%</option><option value={3}>300%</option></select></label></div><div className="wb-toolbar">{(['select','scale','footprint','wall'] as const).map(t=><button key={t} aria-pressed={tool===t} onClick={()=>{setTool(t);setPoints([])}}>{t==='scale'?'Set scale':t==='footprint'?'Trace footprint':t==='wall'?'Add wall':'Select wall'}</button>)}<button disabled={!points.length} onClick={()=>setPoints(p=>p.slice(0,-1))}>Undo point</button>{tool==='scale'&&<><label>Known length (m)<Numeric label="Known dimension" value={distance} min={.01} max={100} onChange={setDistance}/></label><button disabled={points.length!==2} onClick={calibrate}>Confirm scale</button></>}{tool==='footprint'&&<button disabled={points.length<3} onClick={finish}>Finish footprint</button>}</div><p className="wb-hint">{tool==='select'?'Select a traced wall for its dimensions, openings and linked costs.':tool==='scale'?'Click two endpoints of a dimension printed on the plan.':tool==='footprint'?'Click the outer footprint corners in order. Finish replaces the current model.':'Click the two ends of each internal wall.'} {plan.metresPerUnit>0?'Scale calibrated.':'Scale not calibrated.'}</p><div className="wb-plan-scroll"><svg aria-label="Plan tracing canvas" role="img" viewBox={'0 0 1000 '+height} style={{width:zoom*100+'%',maxWidth:'none',cursor:tool==='select'?'default':'crosshair'}} onClick={click}><image href={plan.image} width="1000" height={height}/>{plan.metresPerUnit>0&&g&&g.source===plan.name+' · page '+plan.page&&<><polygon points={g.footprint.map(p=>p.x/scale+','+p.y/scale).join(' ')} fill="#28574715" stroke="#285747" strokeWidth={2}/>{g.walls.map(a=><g key={a.id} onClick={e=>{if(tool==='select'){e.stopPropagation();onSelect(a.id)}}}><line x1={a.a.x/scale} y1={a.a.y/scale} x2={a.b.x/scale} y2={a.b.y/scale} stroke={a.id===selected?'#b86627':'#285747'} strokeWidth={a.id===selected?8:5}/><line x1={a.a.x/scale} y1={a.a.y/scale} x2={a.b.x/scale} y2={a.b.y/scale} stroke="transparent" strokeWidth={20}/><text x={(a.a.x+a.b.x)/2/scale} y={(a.a.y+a.b.y)/2/scale-8} fontSize={14} fill="#173d2e">{length(a.a,a.b).toFixed(2)} m</text></g>)}</>}{points.length>0&&<><polyline points={points.map(p=>p.x+','+p.y).join(' ')} fill="none" stroke="#b86627" strokeWidth={3}/>{points.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={5} fill="#b86627"/>)}</>}</svg></div><p className="wb-hint">Drawing source retained with the project. Reloading preserves the selected page image; reopen the PDF to select another page.</p></>}
    {g&&<><div className="wb-toolbar"><strong>{polygonArea(g.footprint).toFixed(2)} m² · {g.walls.length} walls</strong><select aria-label="Select wall" value={selected} onChange={e=>onSelect(e.target.value)}><option value="">Choose a wall…</option>{g.walls.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select><label><input type="checkbox" checked={g.verified} onChange={e=>changeGeometry({...g,verified:e.target.checked})}/>I checked scale, footprint, wall heights and openings</label></div>{wall&&<div className="wb-wall-editor"><h3>{wall.name} · {length(wall.a,wall.b).toFixed(2)} m · {wallArea(wall).toFixed(2)} m² net wall face</h3><div className="wb-fields"><label>Wall name<input value={wall.name} onChange={e=>updateWall({...wall,name:e.target.value})}/></label>{(['height','thickness'] as const).map(k=><label key={k}>{k} (m)<Numeric label={'Wall '+k} value={wall[k]} min={k==='height'?.5:.05} max={k==='height'?12:1} onChange={n=>updateWall({...wall,[k]:n})}/></label>)}</div><details><summary>Edit wall endpoints (metres from drawing origin)</summary><div className="wb-fields">{(['a','b'] as const).flatMap(end=>(['x','y'] as const).map(axis=><label key={end+axis}>{end.toUpperCase()} {axis}<Numeric label={'Wall '+end+' '+axis} min={-100} max={100} value={wall[end][axis]} onChange={n=>updateWall({...wall,[end]:{...wall[end],[axis]:n}})}/></label>))}</div><p>Connected corners move together with the floor footprint. Recheck measurements after editing.</p></details><label>Location comment<textarea value={wall.note} onChange={e=>updateWall({...wall,note:e.target.value})} placeholder="Dimension to confirm, architectural note…"/></label><h4>Doors & windows</h4>{wall.openings.map(o=><div className="wb-opening" key={o.id}><strong>{o.kind}</strong>{(['offset','width','height','sill'] as const).map(k=><label key={k}>{k} (m)<Numeric label={o.kind+' '+k} value={o[k]} max={100} onChange={n=>updateWall({...wall,openings:wall.openings.map(old=>old.id===o.id?{...o,[k]:n}:old)})}/></label>)}<button onClick={()=>updateWall({...wall,openings:wall.openings.filter(old=>old.id!==o.id)})}>Remove opening</button></div>)}<div className="wb-toolbar">{(['door','window'] as const).map(kind=><button key={kind} onClick={()=>{const o:Opening={id:uid(),kind,offset:wall.openings.reduce((s,o)=>Math.max(s,o.offset+o.width+.1),.1),width:kind==='door'?.9:1.2,height:kind==='door'?2.1:1.2,sill:kind==='door'?0:.9};if(!validOpening(wall,o)){setMessage('There is not enough clear wall space for this opening. Edit existing openings first.');return}updateWall({...wall,openings:[...wall.openings,o]})}}>Add {kind}</button>)}<button onClick={()=>{changeGeometry({...g,verified:false,walls:g.walls.filter(a=>a.id!==wall.id)});onSelect('')}}>Remove wall</button></div><p className="wb-hint">Source: {g.source}. Net area deducts openings once; finishes on both faces need a separate item or rate.</p></div>}</>}
  </section>
}
