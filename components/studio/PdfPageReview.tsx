'use client'
import {useEffect,useState} from 'react'
import {identifySheet,recommendedSheets,type IndexedSheet} from '@/lib/studio-page-index'
import {prepareDocumentPages} from './prepare-document-pages'
import type {DocumentReading} from '@/lib/studio-document-reading'
import type {PlanSource} from '@/lib/studio-workspace'

export default function PdfPageReview({file,onUse,onCancel}:{file:File;onUse:(pages:PlanSource[])=>Promise<void>;onCancel:()=>void}){
 const [sheets,setSheets]=useState<(IndexedSheet&{thumbnail:string})[]>([]),[selected,setSelected]=useState<number[]>([]),[floor,setFloor]=useState(0),[busy,setBusy]=useState(true),[message,setMessage]=useState('Checking every page…')
 useEffect(()=>{const controller=new AbortController();void(async()=>{
  const {resolvePDFJS}=await import('unpdf/pdfjs'),engine=await resolvePDFJS()
  const pdf=await engine.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,useSystemFonts:true}).promise
  try{
   if(pdf.numPages>80)throw new Error('This review supports up to 80 pages. Split the PDF into drawing volumes.')
   const all:(IndexedSheet&{thumbnail:string})[]=[]
   for(let n=1;n<=pdf.numPages;n++){
    controller.signal.throwIfAborted();const p=await pdf.getPage(n),text=await p.getTextContent(),v=p.getViewport({scale:1}),view=p.getViewport({scale:320/Math.max(v.width,v.height)})
    const canvas=document.createElement('canvas');canvas.width=view.width;canvas.height=view.height
    await p.render({canvasContext:canvas.getContext('2d')!,viewport:view}).promise
    all.push({...identifySheet(n,text.items.map((i:any)=>i.str||'').join(' ')),thumbnail:canvas.toDataURL('image/jpeg',.7)});canvas.width=canvas.height=0
    if(!controller.signal.aborted)setMessage(`Checked ${n} of ${pdf.numPages} pages`)
   }
   if(controller.signal.aborted)return
   const first=all.find(s=>s.purpose==='floor')?.page||0,recommended=recommendedSheets(all).filter(n=>n===first||all.find(s=>s.page===n)?.purpose!=='floor').slice(0,8)
   setSheets(all);setSelected(recommended);setFloor(first);setMessage(first?'Review the suggested floor and supporting sheets.':'No floor plan was confidently identified. Choose it from the previews.');setBusy(false)
  }finally{await pdf.destroy()}
 })().catch(e=>{if(!controller.signal.aborted){setMessage(e instanceof Error?e.message:'Unable to review PDF');setBusy(false)}});return()=>controller.abort()},[file])
 const omittedEvidence=sheets.filter(s=>['walls','setout','openings'].includes(s.purpose)&&!selected.includes(s.page))
 async function usePages(){setBusy(true);setMessage('Preparing your selected drawings…');try{
  if(!selected.includes(floor))throw new Error('Select a floor-plan page before continuing.')
  const reading={name:file.name,revision:'',sheets:[...sheets.filter(s=>s.page===floor),...sheets.filter(s=>selected.includes(s.page)&&s.page!==floor)].map(s=>({page:s.page,title:s.title,role:s.page===floor?'floor-plan':s.role}))} as DocumentReading
  const prepared=await prepareDocumentPages(file,reading,new AbortController().signal,true)
  await onUse(prepared.pages)
 }catch(e){setMessage(e instanceof Error?e.message:'Unable to prepare drawings');setBusy(false)}}
 return <section className="wb-card" aria-label="Review PDF pages"><h3>Choose the floor and its supporting drawings</h3><p role="status">{message}</p>{sheets.length>0&&<><p>All {sheets.length} pages checked. Choose one floor and up to seven supporting pages for this reading. The complete original PDF will be saved with this project; unselected pages are not included in this model reading.</p><label>Floor to model <select disabled={busy} value={floor} onChange={e=>{const n=Number(e.target.value);setFloor(n);setSelected(p=>[n,...p.filter(x=>x!==floor&&x!==n)].slice(0,8))}}><option value={0}>Choose floor plan</option>{sheets.map(s=><option key={s.page} value={s.page}>Page {s.page}: {s.title}</option>)}</select></label><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12,maxHeight:560,overflow:'auto',marginTop:12}}>{sheets.map(s=><label key={s.page} style={{border:'1px solid #ccd6ce',padding:10,borderRadius:8,display:'block',minWidth:0,overflowWrap:'anywhere'}}><img src={s.thumbnail} alt={`Page ${s.page}: ${s.title}`} style={{width:'100%',display:'block',marginBottom:8}}/><input type="checkbox" disabled={busy||s.page===floor||(!selected.includes(s.page)&&selected.length>=8)} checked={selected.includes(s.page)} onChange={e=>setSelected(p=>e.target.checked?[...p,s.page]:p.filter(n=>n!==s.page))}/> Page {s.page}: {s.title}{s.page===floor?' — model floor':''}</label>)}</div><p>{selected.length} pages selected. Check that the wall plan, setout and door/window schedules are included where supplied. Recommendations are based on readable sheet titles and need your review.</p>{omittedEvidence.length>0&&<p className="wb-notice">Supporting drawings not selected: {omittedEvidence.map(s=>'page '+s.page+' ('+s.title+')').join(', ')}. Include these to help check dimensions and openings.</p>}<button disabled={busy||!floor||!selected.includes(floor)} onClick={()=>void usePages()}>Use selected drawings</button></>}<button disabled={busy} onClick={onCancel}>Cancel</button></section>
}
