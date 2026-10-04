'use client'

import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Box, Maximize, Minus, Plus, RotateCcw, X } from 'lucide-react'
import type { Design } from '@/lib/project-studio'
import type { Finish, ModelOptions } from './studio-scene'
import type { Viewer } from './studio-viewer'
import PlanFallback from './PlanFallback'
import PhotorealisticRender from './PhotorealisticRender'
import {levels,allRooms} from '@/lib/studio-geometry'

export default function PlanModel({ design, small = false, onSelectWall, selectedWall, title='Project concept', compactControls=false, projectId, beforeRender }: { design: Design; projectId?:string; beforeRender?:()=>Promise<void>; compactControls?: boolean; small?: boolean; onSelectWall?:(id:string)=>void; selectedWall?:string; title?:string }) {
  const host=useRef<HTMLDivElement>(null)
  const shell=useRef<HTMLDivElement>(null)
  const api=useRef<Viewer|null>(null)
  const [mode,setMode]=useState<'design'|'presentation'>('presentation')
  const [plan,setPlan]=useState(false)
  const [walkRoom,setWalkRoom]=useState('')
  const [floorId,setFloorId]=useState('all'),[furniture,setFurniture]=useState(true)
  const [exported,setExported]=useState<{url:string;name:string}|null>(null)
  const [walls,setWalls]=useState(false)
  const [labels,setLabels]=useState(true)
  const [expanded,setExpanded]=useState(false)
  const [finish,setFinish]=useState<Finish>('sage')
  const [roof,setRoof]=useState(false),[section,setSection]=useState(12),[dimensions,setDimensions]=useState(true)
  const [savedView,setSavedView]=useState<{position:number[];zoom:number}|null>(null)
  useEffect(()=>{try{const raw=localStorage.getItem('worka.camera.'+title);if(raw){const v=JSON.parse(raw);if(Array.isArray(v.position)&&v.position.length===3&&v.position.every((n:unknown)=>typeof n==='number'&&Number.isFinite(n))&&v.zoom>=.65&&v.zoom<=1.8)setSavedView(v)}}catch{}},[title])
  function downloadImage(){const data=api.current?.exportImage();if(!data)return;const image=new Image();image.onload=()=>{const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height+52;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#faf9f5';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0);ctx.fillStyle='#285747';ctx.font='14px sans-serif';ctx.fillText('worka. · '+title.slice(0,65)+' · '+(design.geometry&&levels(design.geometry).every(l=>l.geometry.verified)?'Reviewed concept':'Draft — measurements unverified'),16,canvas.height-20);const link=document.createElement('a');link.download=title.replace(/[^a-z0-9 -]/gi,'').slice(0,60)+'-3d.png';link.href=canvas.toDataURL('image/png');setExported({url:link.href,name:link.download});link.click()};image.src=data}
  function saveCamera(){const v=api.current?.saveView();if(v){setSavedView(v);try{localStorage.setItem('worka.camera.'+title,JSON.stringify(v))}catch{}}}
  const selectRef=useRef(onSelectWall);selectRef.current=onSelectWall
  const [status,setStatus]=useState<'loading'|'ready'|'fallback'>('loading')
  const stableDesign=useDeferredValue(design)
  const options:ModelOptions={walls:walkRoom||roof?true:walls,labels:walkRoom?false:labels,dimensions:walkRoom?false:dimensions,presentation:mode==='presentation',finish,roof,section:walkRoom?12:section,selectedWall,floorId,furniture}
  const latest=useRef({design:stableDesign,options})
  latest.current={design:stableDesign,options}
  useEffect(()=>{
    const element=host.current
    if(!element)return
    let disposed=false
    // Fetch the renderer when this view mounts. Visibility only controls drawing;
    // deferred intersection callbacks must never strand the loading indicator.
    void import('./studio-viewer').then(({createViewer})=>{
        if(disposed)return
        try{
          api.current=createViewer(element,latest.current.design,latest.current.options,()=>setStatus('fallback'),id=>selectRef.current?.(id))
          setStatus('ready')
        }catch{setStatus('fallback')}
      }).catch(()=>{if(!disposed)setStatus('fallback')})
    return ()=>{disposed=true;api.current?.dispose();api.current=null}
  },[])
  useEffect(()=>{api.current?.update(stableDesign,latest.current.options)},[stableDesign,walls,labels,mode,finish,status,roof,section,selectedWall,dimensions,walkRoom,floorId,furniture])
  useEffect(()=>{setWalkRoom('');setFloorId('all');api.current?.reset()},[design.geometry])
  useEffect(()=>{
    if(status==='fallback'){api.current?.dispose();api.current=null}
  },[status])
  useEffect(()=>{
    api.current?.expanded(expanded)
    if(!expanded)return
    const previous=document.activeElement as HTMLElement|null
    const oldOverflow=document.body.style.overflow
    document.body.style.overflow='hidden'
    const close=shell.current?.querySelector<HTMLButtonElement>('[aria-label="Exit expanded view"]')
    close?.focus()
    const listener=(e:KeyboardEvent)=>{
      if(e.key==='Escape'){e.preventDefault();setExpanded(false)}
      if(e.key==='Tab'){
        const all=Array.from(shell.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select:not(:disabled), a[href], summary, [tabindex="0"]')||[]).filter(el=>el.getClientRects().length>0)
        const first=all[0],last=all.at(-1)
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}
      }
    }
    document.addEventListener('keydown',listener)
    return ()=>{document.body.style.overflow=oldOverflow;document.removeEventListener('keydown',listener);previous?.focus()}
  },[expanded])
  function changePlan(value:boolean){setWalkRoom('');setPlan(value);if(value)setMode('design');api.current?.view(value?'plan':'perspective')}
  function presentation(){setWalkRoom('');setMode('presentation');setPlan(false);setWalls(false);api.current?.view('perspective')}
  function reset(){setWalkRoom('');setPlan(false);api.current?.reset()}
  if(status==='fallback')return <div className="studio-model-fallback"><p>Accelerated 3D is unavailable. Showing the measured floor plan.</p>{design.geometry?<svg viewBox={Math.min(...design.geometry.footprint.map(p=>p.x))+' '+Math.min(...design.geometry.footprint.map(p=>p.y))+' '+design.width+' '+design.depth} style={{width:'100%',height:300}}>{design.geometry.walls.map(w=><line key={w.id} x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke="#285747" strokeWidth={w.thickness}/>)}</svg>:<PlanFallback design={design} small={small}/>}</div>
  return <div ref={shell} className={'studio-model studio-webgl '+(small?'small ':'')+(expanded?'expanded ':'')+(mode==='presentation'?'presentation':'design')} role={expanded?'dialog':undefined} aria-modal={expanded?true:undefined} aria-label={expanded?'Expanded model viewer':undefined}>
    <div className="studio-model-top"><span className="studio-tag"><Box size={12}/>{plan?'Floor plan':mode==='presentation'?'Client presentation':'Design view'}</span><div className="studio-segment"><button type="button" disabled={status!=='ready'} aria-pressed={!plan} onClick={()=>changePlan(false)}>3D</button><button type="button" disabled={status!=='ready'} aria-pressed={plan} onClick={()=>changePlan(true)}>Plan</button></div>{expanded&&<button className="studio-view-close" aria-label="Exit expanded view" onClick={()=>setExpanded(false)}><X size={20}/></button>}</div>
    <div className="studio-canvas-wrap">
      <div ref={host} className="studio-canvas" role="img" tabIndex={0} aria-label={'Interactive '+design.width.toFixed(1)+' by '+design.depth.toFixed(1)+' metre concept. Drag to rotate; arrow keys rotate; plus and minus zoom.'} onKeyDown={e=>{
        if(walkRoom&&['w','a','s','d'].includes(e.key.toLowerCase())){e.preventDefault();const k=e.key.toLowerCase();api.current?.move(k==='w'?1:k==='s'?-1:0,k==='d'?1:k==='a'?-1:0);return}
        if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','Home'].includes(e.key)){
          e.preventDefault()
          if(e.key==='Home')reset()
          else if(e.key==='+'||e.key==='=')api.current?.zoom(1)
          else if(e.key==='-')api.current?.zoom(-1)
          else api.current?.rotate(e.key==='ArrowLeft'?-.16:e.key==='ArrowRight'?.16:0,e.key==='ArrowUp'?-.12:e.key==='ArrowDown'?.12:0)
        }
      }}/>
      {status==='loading'&&<div className="studio-model-loading" role="status"><span/><strong>Preparing your space</strong><p>Loading the interactive model…</p></div>}
      {!small&&<div className="studio-model-caption"><span>{title}</span><strong>{mode==='presentation'?'Explore the proposed space':design.width.toFixed(1)+' × '+design.depth.toFixed(1)+' m bounds'}</strong><small>{design.geometry?(levels(design.geometry).every(l=>l.geometry.verified)?'Reviewed geometry · concept only':'Draft geometry · measurements unverified'):'Sample concept · illustrative furnishings'}</small></div>}
    </div>
    <div className="studio-model-bottom"><span>{plan?'Gross footprint · external dimensions':expanded?'Drag to orbit · scroll or pinch to zoom':'Drag to orbit · pinch or Ctrl + scroll to zoom'}</span><div className="studio-tools"><button type="button" disabled={status!=='ready'} aria-label="Zoom out" onClick={()=>api.current?.zoom(-1)}><Minus size={16}/></button><button type="button" disabled={status!=='ready'} aria-label="Zoom in" onClick={()=>api.current?.zoom(1)}><Plus size={16}/></button><button type="button" disabled={status!=='ready'} aria-label="Reset view" onClick={reset}><RotateCcw size={16}/></button><button type="button" aria-label={expanded?'Exit expanded view':'Expand view'} onClick={()=>setExpanded(v=>!v)}>{expanded?<ArrowLeft size={16}/>:<Maximize size={16}/>}</button></div></div>
    <details className="wb-view-settings" open={compactControls?undefined:true}><summary>View settings</summary>
    {!small&&<div className="studio-view-options"><div className="studio-segment"><button type="button" aria-pressed={mode==='presentation'} onClick={presentation}>Presentation</button><button type="button" aria-pressed={mode==='design'} onClick={()=>setMode('design')}>Design</button></div>{mode==='design'?<div className="studio-design-toggles"><label><input type="checkbox" checked={walls} onChange={e=>setWalls(e.target.checked)}/>Full walls</label><label><input type="checkbox" checked={labels} onChange={e=>setLabels(e.target.checked)}/>Labels</label></div>:<div className="studio-finishes" aria-label="Illustrative finish palette"><button aria-label="Sage and oak finish" aria-pressed={finish==='sage'} onClick={()=>setFinish('sage')}><i className="sage"/>Sage & oak</button><button aria-label="Warm neutral finish" aria-pressed={finish==='sand'} onClick={()=>setFinish('sand')}><i className="sand"/>Warm neutral</button></div>}</div>}
    {!small&&<PhotorealisticRender projectId={projectId} beforeGenerate={beforeRender} capture={()=>api.current?.exportImage()} title={title} revision={JSON.stringify(design)}/>}
    {walkRoom&&<div className="wb-toolbar"><span>Drag to look · W/A/S/D to move · concept navigation without collision checking</span><button onClick={()=>api.current?.move(1,0)}>Forward</button><button onClick={()=>api.current?.move(-1,0)}>Back</button><button onClick={()=>api.current?.move(0,-1)}>Step left</button><button onClick={()=>api.current?.move(0,1)}>Step right</button><button onClick={()=>{setWalkRoom('');api.current?.reset()}}>Exit walkthrough</button></div>}
    {exported&&<div className="wb-export-preview"><p>Image ready. <a href={exported.url} download={exported.name}>Save PNG image</a> <button onClick={()=>setExported(null)}>Close preview</button></p><img src={exported.url} alt="Exported 3D view" style={{width:'100%',maxHeight:360,objectFit:'contain'}}/></div>}
    {!small&&<div className="wb-view-controls">{design.geometry&&<>{allRooms(design.geometry).length>0&&<label>Walk through room<select aria-label="Walk through room" value={walkRoom} onChange={e=>{const id=e.target.value;setWalkRoom(id);setFloorId('all');setRoof(false);setPlan(false);if(id)api.current?.walk(id);else api.current?.reset()}}><option value="">Outside view</option>{levels(design.geometry).flatMap(l=>(l.geometry.rooms||[]).map(r=><option key={r.id} value={r.id}>{l.name} · {r.name}</option>))}</select></label>}<label>Show floor<select aria-label="Visible floor" value={floorId} onChange={e=>{setFloorId(e.target.value);setWalkRoom('');api.current?.reset()}}><option value="all">All floors</option>{levels(design.geometry).map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label><label><input type="checkbox" checked={furniture} onChange={e=>setFurniture(e.target.checked)}/>Illustrative furniture</label></>}<button disabled={status!=='ready'} onClick={downloadImage}>Download image</button><button onClick={()=>{setWalkRoom('');setPlan(false);api.current?.view('front')}}>Front</button><button onClick={()=>{setWalkRoom('');setPlan(false);api.current?.view('side')}}>Side</button><button disabled={!!walkRoom} onClick={saveCamera}>Save viewpoint</button><button disabled={!savedView} onClick={()=>{if(savedView){setWalkRoom('');setPlan(false);api.current?.restoreView(savedView)}}}>Recall viewpoint</button>{design.geometry&&<><label><input type="checkbox" checked={roof} onChange={e=>setRoof(e.target.checked)}/>Concept roof</label>{mode==='design'&&<><label><input type="checkbox" checked={dimensions} onChange={e=>setDimensions(e.target.checked)}/>Dimensions</label><label>Section height <input aria-label="Section height" type="range" min="0.3" max={design.height} step="0.1" value={Math.min(section,design.height)} onChange={e=>{setWalls(true);setSection(Number(e.target.value))}}/>{section>=design.height?'Full':section.toFixed(1)+' m'}</label></>}</>}</div>}
    </details>
  </div>
}
