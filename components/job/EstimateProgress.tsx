'use client'
import {useEffect,useState} from 'react'
export default function EstimateProgress({jobId}:{jobId:string}) {
 const [progress,setProgress]=useState<any>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 useEffect(()=>{let cancelled=false; const refresh=async()=>{try{const res=await fetch(`/api/jobs/${jobId}/estimate-progress`);if(!res.ok)throw Error('Estimate progress could not be loaded. Retrying automatically.');const data=await res.json();if(!cancelled){setProgress(data);setError('')}}catch(e){if(!cancelled)setError(e instanceof Error?e.message:'Progress unavailable. Retrying automatically.')}};void refresh();const timer=setInterval(refresh,5000);return()=>{cancelled=true;clearInterval(timer)}},[jobId])
 const w=progress?.workflow;if(!w||w.state==='complete')return error?<p role="alert" className="p-4">{error}</p>:null
 const paused=w.state.startsWith('paused'),attention=w.state==='needs_attention'
 async function resume(){setBusy(true);setError('');try{const res=await fetch(`/api/jobs/${jobId}/estimate-progress`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({extend:w.state==='paused_budget'})});const result=await res.json();if(!res.ok)throw Error(result.error);setProgress({...progress,workflow:{...w,state:'queued',reason:null}})}catch(e){setError(e instanceof Error?e.message:'Unable to resume')}finally{setBusy(false)}}
 return <section className="p-4 mb-4 rounded-xl" style={{border:'1px solid var(--bg-border)'}} aria-live="polite">
 <h3 className="font-semibold">{attention?'Estimate needs attention':paused?'Estimate paused':'Preparing your estimate'}</h3>
 <p className="text-sm mt-2">{attention?'Processing needs a review. Your saved work is safe.':paused?w.reason:'You can leave this page. Worka will continue in the background.'}</p>
 <p className="text-sm mt-2">{progress.completed_trades} trades prepared · {progress.attempts} of {w.attempt_limit} processing attempts used</p>
 {paused&&<><p className="text-sm mt-2">{w.state==='paused_budget'?'Continue approves up to 10 additional attempts within your account allowance. Daily limits still apply.':w.state==='paused_service'?'Service protection is active. Resume after the service is restored.':'Resume after your daily allowance becomes available.'}</p><button className="btn-primary mt-3 px-4 py-2" disabled={busy} onClick={resume}>{busy?'Resuming…':'Resume estimate'}</button></>}
 {error&&<p role="alert" className="text-sm mt-2">{error}</p>}
 </section>
}
