'use client'
import { useState } from 'react'
type Review={id:string;quote_id:string;resolution_type:string|null}
export default function MoneyQuestion({jobId,question}:{jobId:string;question:{id:string;question:string;reason:string;answer?:string|null;answer_review?:Review|null}}) {
 const [answer,setAnswer]=useState(question.answer??'')
 const [previous,setPrevious]=useState(question.answer??null)
 const [saved,setSaved]=useState(!!question.answer)
 const [review,setReview]=useState<Review|null>(question.answer_review??null)
 const [saving,setSaving]=useState(false),[error,setError]=useState('')
 async function save(){
 if(saving||!answer.trim())return
 setSaving(true);setError('')
 try{
 const res=await fetch('/api/jobs/'+jobId+'/questions/'+question.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answer:answer.trim(),previous_answer:previous})})
 const data=await res.json();if(!res.ok)throw new Error(data.error??'Could not save answer')
 setPrevious(answer.trim());setReview(data.review);setSaved(true)
 }catch(e){setError(e instanceof Error?e.message:'Could not save answer. Please try again.')}finally{setSaving(false)}
 }
 async function confirmReview(){
 if(!review||saving)return;setSaving(true);setError('')
 try{const res=await fetch('/api/assumptions/'+review.quote_id+'/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({assumption_id:review.id,resolution:'accepted',reason:'Builder confirmed the saved answer is reflected in the estimate.'})});const data=await res.json();if(!res.ok)throw Error(data.error??'Could not confirm review');setReview({...review,resolution_type:'accepted'})}catch(e){setError(e instanceof Error?e.message:'Could not confirm review')}finally{setSaving(false)}
 }
 return <div className="p-3 border-b" style={{borderColor:'var(--bg-border)'}}>
 <label htmlFor={'answer-'+question.id} className="text-sm font-medium">{question.question}</label>
 <p className="text-xs my-1" style={{color:'var(--text-secondary)'}}>{question.reason}</p>
 {saved?<><p className="text-sm whitespace-pre-wrap">{previous}</p><p role="status" className="text-xs mt-2">{review?.resolution_type?'Answer reviewed.':'Answer saved to job knowledge. Review affected scope and prices in Review estimate before confirming below. Prices have not changed automatically.'}</p><button type="button" className="btn-secondary px-3 py-2 mt-2" onClick={()=>setSaved(false)} disabled={saving}>Edit answer</button>{review&&!review.resolution_type&&<button type="button" className="btn-primary px-3 py-2 m-2" disabled={saving} onClick={confirmReview}>I have reflected this answer in the estimate</button>}</>:<>
 <textarea id={'answer-'+question.id} value={answer} onChange={e=>setAnswer(e.target.value)} maxLength={4000} disabled={saving} rows={3} placeholder="Your answer" className="w-full rounded p-2 text-sm" style={{background:'var(--bg-elevated)',color:'var(--text-primary)'}}/>
 <button type="button" className="btn-primary px-3 py-2 mt-2 text-sm" disabled={saving||!answer.trim()} onClick={save}>{saving?'Saving…':'Save answer'}</button>
 </>}{error&&<p role="alert" className="text-sm mt-2">{error}</p>}
 </div>
}
