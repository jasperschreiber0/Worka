'use client'
import {useRef,useState} from 'react'
export default function JobPhotoUpload({jobId,onUploaded}:{jobId:string;onUploaded:(ids:string[])=>void}){
 const [files,setFiles]=useState<{file:File;key:string;id?:string}[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const input=useRef<HTMLInputElement>(null)
 function add(incoming:FileList|null){if(!incoming)return;const list=Array.from(incoming);if(list.some(f=>!f.type.startsWith('image/')||f.size>52428800)){setError('Choose image files up to 50 MB each. Originals are retained.');return}setFiles(old=>[...old,...list.map(file=>({file,key:crypto.randomUUID()}))])}
 async function upload(){setBusy(true);setError('');const ids:string[]=[];try{for(const f of files){if(f.id){ids.push(f.id);continue}
 const r=await fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({job_id:jobId,filename:f.file.name,content_type:f.file.type,size:f.file.size,upload_client_key:f.key})}),d=await r.json();if(!r.ok)throw Error(d.error)
 if(d.upload_url){const u=await fetch(d.upload_url,{method:'PUT',headers:{'Content-Type':f.file.type},body:f.file});if(!u.ok)throw Error('A photo did not finish uploading. Retry to keep your completed uploads.')}
 const endpoint=`/api/jobs/${jobId}/drawings`;const v=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'finalise',file_id:d.file.id})}),verified=await v.json();if(!v.ok)throw Error(verified.error)
 const original=verified.file?.duplicate_of_file_id,photoId=original??d.file.id
 if(!original&&verified.file?.drawing_state!=='evidence'){const a=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'reconcile',relationship:'evidence',file_id:d.file.id})});if(!a.ok)throw Error('Photo saved. Retry to finish attaching its evidence record.')}
 f.id=photoId;ids.push(photoId);setFiles(current=>current.map(x=>x.key===f.key?{...x,id:photoId}:x))
 }onUploaded(Array.from(new Set(ids)));setFiles([])}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 return <section className="pi-card" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(!busy)add(e.dataTransfer.files)}}><h2>Site photos</h2><p>Drop photos here or choose them from your phone. Add a short note and review the proposed issue after uploading.</p><input ref={input} type="file" accept="image/*" multiple hidden onChange={e=>{add(e.target.files);e.target.value=''}}/><button type="button" disabled={busy} onClick={()=>input.current?.click()}>Choose photos</button>{files.length>0&&<><p>{files.map(f=>`${f.file.name}${f.id?' — saved':''}`).join(', ')}</p><button type="button" className="primary" disabled={busy} onClick={upload}>{busy?'Saving photos…':'Save photos and prepare site update'}</button></>}{error&&<p role="alert">{error}</p>}</section>
}
