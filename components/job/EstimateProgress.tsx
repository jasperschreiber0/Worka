'use client'
import {useEffect,useState} from 'react'
import styles from './EstimateProgress.module.css'
export interface Progress {workflow:{state:string;reason:string|null;updated_at:string};quote_id:string|null;started_at:string;documents:{total:number;completed:number;failed:number};completed_trades:number}
export default function EstimateProgress({jobId,onReview}:{jobId:string;onReview?:(id:string)=>void}) {
 const [progress,setProgress]=useState<Progress|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[now,setNow]=useState(Date.now())
 useEffect(()=>{let cancelled=false,timer:ReturnType<typeof setTimeout>;const abort=new AbortController();setProgress(null);setError('')
  async function refresh(){try{const res=await fetch(`/api/jobs/${jobId}/estimate-progress`,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});if(!res.ok)throw Error('Progress is temporarily unavailable. Your saved work is safe.');const data=await res.json();if(!cancelled){setProgress(data);setError('');setNow(Date.now())}}catch(e){if(!cancelled)setError(e instanceof Error?e.message:'Progress unavailable.')}finally{if(!cancelled)timer=setTimeout(refresh,5000)}}
  void refresh();return()=>{cancelled=true;abort.abort();clearTimeout(timer)}
 },[jobId])
 async function resume(){if(!progress?.workflow)return;const w=progress.workflow;setBusy(true);setError('');try{const res=await fetch(`/api/jobs/${jobId}/estimate-progress`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({extend:w.state==='paused_budget'})});const result=await res.json();if(!res.ok)throw Error(result.error);setProgress({...progress,workflow:{...w,state:'queued',reason:null}})}catch(e){setError(e instanceof Error?e.message:'Unable to resume')}finally{setBusy(false)}}
 return <EstimateProgressCard progress={progress} error={error} busy={busy} now={now} onResume={resume} onReview={onReview} />
}
export function EstimateProgressCard({progress,error='',busy=false,now=Date.now(),onResume,onReview}:{progress:Progress|null;error?:string;busy?:boolean;now?:number;onResume?:()=>void;onReview?:(id:string)=>void}) {
 const w=progress?.workflow
 if(!w)return error?<p role="alert" className="p-4">{error}</p>:null
 const done=w.state==='complete'&&!!progress.quote_id,paused=w.state.startsWith('paused'),attention=w.state==='needs_attention'||(w.state==='complete'&&!progress.quote_id)
 const elapsed=Math.max(0,Math.floor((((done||paused||attention)?Date.parse(w.updated_at):now)-Date.parse(progress.started_at))/1000)),overdue=elapsed>=300&&!done
 const active=!done&&!paused&&!attention&&!overdue&&!error
 const docs=progress.documents,read=docs.total>0&&docs.completed+docs.failed===docs.total
 const title=done?'Your draft is ready to review':attention?'Your estimate needs attention':paused?'Your estimate is paused':overdue?'This estimate is taking longer than expected':'Worka is preparing your estimate'
 return <section className={`${styles.card} ${active?styles.active:''}`} aria-label="Estimate progress">
  <div className={styles.heading}><span className={`${styles.indicator} ${active?styles.pulse:''} ${done?styles.complete:''}`} aria-hidden="true">{done?'✓':active?'✦':'!'}</span><div><h3 className="font-semibold" role="status">{title}</h3><p className={styles.muted}>{done?'Check the scope, prices and Needs input before sending. Nothing has been sent.':paused||attention?w.reason||'Your saved work is safe. Review the issue before continuing.':overdue?'Your progress is saved. We have not marked incomplete work as ready.':'Working on this estimate only. You can leave this page while processing continues.'}</p></div></div>
  <ol className={styles.stages} aria-label="Processing stages">{['Read documents','Prepare scope and prices','Save draft'].map((label,i)=>{const complete=done||(i===0&&read),current=active&&i===(read?1:0);return <li key={label} className={complete?styles.finished:current?styles.current:''} aria-current={current?'step':undefined}><span aria-hidden="true">{complete?'✓':i+1}</span>{label}</li>})}</ol>
  <div className={styles.footer}><p>{docs.completed} of {docs.total} documents read{docs.failed>0?` · ${docs.failed} need attention`:''}</p><p>{Number.isFinite(elapsed)?`${Math.floor(elapsed/60)}m ${elapsed%60}s elapsed`:''}</p></div>
  {!done&&!paused&&!attention&&<p className={styles.muted}>{overdue?'The five-minute target has been exceeded. Processing may still finish; the live status above will update.':'Our target is a reviewable draft within five minutes. Missing prices will be flagged for your input.'}</p>}
  {done&&onReview&&<button className="btn-primary mt-4 px-4 py-3" onClick={()=>onReview(progress.quote_id!)}>Review draft →</button>}
  {paused&&<><p className={styles.muted}>{w.state==='paused_budget'?'Continue approves up to 10 additional attempts within your account allowance. Daily limits still apply.':w.state==='paused_timeout'?'Resume starts another five-minute window for this estimate only, within your remaining processing allowance.':'Resume when the processing allowance or service becomes available.'}</p><button className="btn-primary mt-3 px-4 py-2" disabled={busy} onClick={onResume}>{busy?'Resuming…':'Resume this estimate'}</button></>}
  {error&&<p role="alert" className="text-sm mt-2">{error} Retrying automatically.</p>}
 </section>
}
