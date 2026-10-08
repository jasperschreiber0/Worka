'use client'
import {useEffect,useRef,useState,type ReactNode} from 'react'
import {ArrowRight,Search,X,Plus,FolderOpen} from 'lucide-react'
type Project={id:string;name:string;version:number}
const testJob=(p:Project)=>/^(QA\b|TEST ONLY\b|Builder rehearsal\b)/i.test(p.name)
export default function ProjectPicker({projects,currentId,dirty,busy,onSave,onOpen,onClose,onNew,children}:{projects:Project[];currentId:string;dirty:boolean;busy:boolean;onSave:()=>void;onOpen:(id:string)=>void;onClose:()=>void;onNew:()=>void;children:ReactNode}){
 const [query,setQuery]=useState(''),[showTests,setShowTests]=useState(false)
 const dialog=useRef<HTMLDialogElement>(null)
 useEffect(()=>{const el=dialog.current;el?.showModal();return()=>el?.close()},[])
 const tests=projects.filter(testJob),visible=projects.filter(p=>(showTests||!testJob(p))&&p.name.toLowerCase().includes(query.toLowerCase()))
 return <dialog ref={dialog} className="wb-job-dialog" aria-labelledby="job-picker-title" onCancel={onClose}>
  <header className="wb-job-header"><div><p className="wb-eyebrow">YOUR WORKSPACE</p><h2 id="job-picker-title">Open a job</h2><p>Pick up where you left off.</p></div><button aria-label="Close projects" onClick={onClose}><X size={20}/></button></header>
  <div className="wb-job-actions"><label className="wb-job-search"><Search size={18}/><input autoFocus aria-label="Find a job" placeholder="Find a job…" value={query} onChange={e=>setQuery(e.target.value)}/></label><button className="wb-primary" onClick={onNew}><Plus size={16}/>New job</button></div>
  {dirty&&<div className="wb-job-unsaved"><span>Save your current edits before switching jobs.</span><button disabled={busy} onClick={onSave}>{busy?'Saving…':'Save edits'}</button></div>}
  <div className="wb-job-list">{visible.map(p=><button key={p.id} disabled={busy} className={'wb-job-option'+(p.id===currentId?' is-current':'')} onClick={()=>onOpen(p.id)}><FolderOpen size={20}/><span><strong>{p.name.split(' — ')[0]}</strong><small>{p.id===currentId?'Currently open':testJob(p)?'Test project':p.name.includes(' — ')?p.name.split(' — ').slice(1).join(' — '):'Saved project'}</small></span>{p.id===currentId?<span className="wb-job-badge">Open</span>:<ArrowRight size={18}/>}</button>)}{!visible.length&&<p className="wb-empty">No jobs match your search.</p>}</div>
  <footer className="wb-job-footer">{!!tests.length&&<label><input type="checkbox" checked={showTests} onChange={e=>setShowTests(e.target.checked)}/>Show test projects ({tests.length})</label>}{children}</footer>
 </dialog>
}
