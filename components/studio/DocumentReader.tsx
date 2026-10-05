'use client'
import {useEffect,useRef,useState} from 'react'
import {drawingFingerprint} from '@/lib/studio-model-progress'
import {generateBuildingDraft} from '@/lib/studio-generate-building'
import type {Workspace} from '@/lib/studio-workspace'
import {newScopeReview} from '@/lib/studio-scope'
import {applyDocumentItems,validDocumentReadings} from '@/lib/studio-document-reading'
import {appendModelPages} from '@/lib/studio-model-pages'
import {prepareDocumentPages} from './prepare-document-pages'
import {validBuilding} from '@/lib/studio-building'
import {revise} from '@/lib/project-studio'
import {prepareLinkedTakeoff} from '@/lib/studio-draft-takeoff'
export default function DocumentReader({workspace:w,onChange,onCheckpoint}:{workspace:Workspace;onChange:(w:Workspace)=>void;onCheckpoint?:(w:Workspace)=>Promise<void>}){
 const [mode,setMode]=useState<'local'|'ai'>('local'),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[selected,setSelected]=useState<string[]>([])
 const [autoModel,setAutoModel]=useState(true)
 const current=useRef(w),abort=useRef<AbortController|null>(null);current.current=w
 useEffect(()=>()=>abort.current?.abort(),[])
 async function read(files:File[]){if(busy||!files.length)return;setBusy(true);const project=w.project.id;let preparedPlans=false
 try{for(const [index,file] of Array.from(files.entries())){
  if(file.size>20*1024*1024)throw new Error(`${file.name} exceeds 20 MB.`)
  if((current.current.documentReadings?.length||0)>=20)throw new Error('This project holds up to 20 document readings.')
  setMessage(`Reading ${index+1} of ${files.length}: ${file.name}. This can take a few minutes.`)
  const encoded=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Unable to open PDF.'));reader.readAsDataURL(file)})
  const controller=new AbortController();abort.current=controller;const timeout=setTimeout(()=>controller.abort(),235000)
  let response;try{response=await fetch('/api/studio/read-document',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name,pdf:encoded,mode}),signal:controller.signal})}finally{clearTimeout(timeout)}
  const data=await response.json();if(!response.ok)throw new Error(data.error||'Document reading failed.')
  if(current.current.project.id!==project)return
  if(!validDocumentReadings([data.reading]))throw new Error('The reading was invalid; existing work is unchanged.')
  const now=current.current,existing=now.documentReadings||[],review=structuredClone(now.scopeReview||newScopeReview()),reading=data.reading
  const duplicate=existing.some(d=>d.id===reading.id)
  const registered=review.documents.find(d=>d.name===file.name)
  if(registered){registered.pages=reading.pages;if(!registered.revision)registered.revision=reading.revision;registered.status='unreviewed'}
  else if(review.documents.length<80)review.documents.push({name:file.name,pages:reading.pages,revision:reading.revision,status:'unreviewed',note:'Read automatically; confirm the governing revision and scope.'})
  const next={...now,scopeReview:duplicate?now.scopeReview:review,documentReadings:duplicate?existing:[...existing,reading]};current.current=next;onChange(next)
  if(onCheckpoint)await onCheckpoint(next)
  setMessage(`Preparing model pages from ${file.name}…`)
  const prepared=await prepareDocumentPages(file,reading,controller.signal)
  if(current.current.project.id!==project||controller.signal.aborted)return
  if(prepared.pages.length){
   const latest=current.current,merged=appendModelPages(latest.drawings|| (latest.plan?[latest.plan]:[]),prepared.pages)
   const notes=[...prepared.omitted.map(s=>'Not automatically selected for 3D: '+s),...merged.skipped]
   const updated={...latest,drawings:merged.pages,plan:latest.plan||merged.pages.find(p=>p.role==='floor-plan')||null,documentReadings:latest.documentReadings?.map(d=>d.id===reading.id?{...d,warnings:Array.from(new Set([...d.warnings,...notes])).slice(0,140)}:d)}
   current.current=updated;onChange(updated)
   if(onCheckpoint)await onCheckpoint(updated)
   preparedPlans=true
  }
 }
 if(mode==='ai'&&autoModel&&preparedPlans&&!current.current.project.working.design.geometry){
  const latest=current.current,pages=latest.drawings||[],stamp=JSON.stringify(latest.project.working),controller=new AbortController();abort.current=controller
  setMessage('Documents read. Generating your 3D draft from the saved floor plans…')
  const timer=setTimeout(()=>controller.abort(),660000)
  try{
   const source=await drawingFingerprint(pages)
   const data=await generateBuildingDraft(pages,controller.signal,setMessage,fetch,{previousDraft:latest.modelProgress?.source===source&&(latest.modelProgress.draft as any)?.kind!=='staged-floor-v1'?latest.modelProgress.draft:undefined,save:async(draft,error)=>{if(current.current.project.id!==project)throw new Error('Project changed.');const progress={...current.current,modelProgress:{source,draft,error,at:new Date().toISOString()}};current.current=progress;onChange(progress);if(onCheckpoint)await onCheckpoint(progress)}})
   if(current.current.project.id!==project)return
   if(!validBuilding(data.geometry)||!data.design||JSON.stringify(data.design.geometry)!==JSON.stringify(data.geometry)||!Array.isArray(data.warnings)||data.warnings.length>250||!data.warnings.every((s:unknown)=>typeof s==='string'&&s.length<=1200))throw new Error('The model did not pass validation.')
   if(JSON.stringify(current.current.project.working)!==stamp)throw new Error('Your estimate changed during generation. Use the saved pages to generate again against the current version.')
   const updated={...current.current,modelProgress:undefined,setReview:{at:new Date().toISOString(),warnings:data.warnings},project:revise(current.current.project,{design:data.design})};current.current=updated;onChange(updated)
   try{const takeoff=prepareLinkedTakeoff(updated,updated.scopeReview?.kind==='new-build');current.current=takeoff.workspace;onChange(takeoff.workspace);if(onCheckpoint)await onCheckpoint(takeoff.workspace);setMessage(`Documents and 3D draft are ready. ${takeoff.added} linked wall and floor items prepared. Confirm new versus retained work, review prices. Your completed steps have been saved.`)}catch(e){setMessage('The model is ready. Linked cost preparation needs attention: '+(e as Error).message)}
  }catch(e){
   if(current.current.project.id!==project)return
   const reason=(e instanceof Error?e.message:'Generation did not finish.').slice(0,1100)
   const updated={...current.current,setReview:{at:new Date().toISOString(),warnings:['Automatic model generation incomplete: '+reason]}};current.current=updated;onChange(updated)
   setMessage('Your document readings and plan pages have been kept. The 3D model still needs attention: '+reason)
   if(onCheckpoint)await onCheckpoint(current.current)
  }finally{clearTimeout(timer)}
 }else setMessage('Document review complete. Identified floor-plan pages are saved in Plan setup for 3D generation. Review omitted pages and save your project.')
 }catch(e){setMessage((e as Error).name==='AbortError'?'Reading stopped or timed out. Previously completed readings have been kept.':(e as Error).message)}finally{setBusy(false);abort.current=null}}
 return <details className="wb-card"><summary><strong>Plans & selections</strong> · {w.documentReadings?.length||0} documents read</summary><p>Add your PDFs, then review the items Worka finds. Missing quantities and prices stay flagged.</p><label>Reading method <select disabled={busy} value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value="local">Local schedule extraction — stays on this computer in local mode</option><option value="ai">AI plan interpretation — sends PDFs to the configured AI provider</option></select></label>{mode==='ai'&&<label><input type="checkbox" checked={autoModel} disabled={busy} onChange={e=>setAutoModel(e.target.checked)}/>Generate a 3D draft after reading the plans. Selected drawing pages are sent to the same AI provider.</label>}<label>PDF plans and schedules <input type="file" accept="application/pdf,.pdf" multiple disabled={busy} onChange={e=>{void read(Array.from(e.target.files||[]));e.target.value=''}}/></label>{busy&&<button onClick={()=>abort.current?.abort()}>Stop reading</button>}{message&&<p role="status">{message}</p>}
 {(w.documentReadings||[]).map(d=><details className="wb-card" key={d.id}><summary>{d.name} · {d.pages} pages · {d.items.length} extracted items · {d.applied.length} added</summary><p>{d.summary}</p><p>Revision: {d.revision||'Not identified'} · Quantity and pricing checks still required.</p><details><summary>Drawing index</summary><ul>{d.sheets.map((s,i)=><li key={i}>Page {s.page}: {s.title} ({s.role})</li>)}</ul></details>{d.questions.length>0&&<details open><summary>Questions raised by this document</summary><ul>{d.questions.map((q,i)=><li key={i}>{q}</li>)}</ul></details>}{d.warnings.length>0&&<details><summary>Limitations and omitted items ({d.warnings.length})</summary><ul>{d.warnings.map((q,i)=><li key={i}>{q}</li>)}</ul></details>}
 <p>Unknown quantities become unmeasured items. Prices with unknown GST treatment remain unpriced. Imported supply prices are provisional and exclude installation unless explicitly stated.</p><button onClick={()=>setSelected(Array.from(new Set([...selected,...d.items.filter(i=>!d.applied.includes(i.id)).map(i=>i.id)])))}>Select remaining draft items</button> <button disabled={busy||!d.items.some(i=>selected.includes(i.id)&&!d.applied.includes(i.id))} onClick={()=>{try{const ids=d.items.filter(i=>selected.includes(i.id)&&!d.applied.includes(i.id)).map(i=>i.id);onChange(applyDocumentItems(current.current,d.id,ids));setSelected(selected.filter(id=>!ids.includes(id)));setMessage('Draft items added. Review quantities, scope overlaps, tax treatment and rates before approval.')}catch(e){setMessage((e as Error).message)}}}>Add selected to draft estimate</button>
 {d.items.map(i=><details className="wb-card" key={i.id}><summary>{i.name} · {i.quantity===null?'Quantity needed':`${i.quantity} ${i.unit}`}{d.applied.includes(i.id)?' · Added':''}</summary><label><input type="checkbox" checked={selected.includes(i.id)} disabled={d.applied.includes(i.id)} onChange={e=>setSelected(e.target.checked?[...selected,i.id]:selected.filter(id=>id!==i.id))}/> Include this draft item</label><p>{i.basis}</p><p>Printed unit supply price: {i.price===null?'Not supplied':`$${i.price}`} · GST {i.tax}. {i.priceBasis}</p>{i.evidence.map((e,j)=><blockquote key={j}>Page {e.page}: {e.quote}</blockquote>)}</details>)}
 </details>)}
 </details>
}
