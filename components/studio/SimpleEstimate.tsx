'use client'
import {useRef,useState} from 'react'
import type {Workspace} from '@/lib/studio-workspace'
import {parseWorkspace} from '@/lib/studio-workspace'
import {money,revise} from '@/lib/project-studio'
import {preparePriceDraft,markupForTotal} from '@/lib/studio-price-draft'
export default function SimpleEstimate({workspace:w,onChange,onReview,onDetails}:{workspace:Workspace;onChange:(w:Workspace)=>void;onReview:()=>void;onDetails:()=>void}){
 const draft=preparePriceDraft(w.project.working,w.rates),t=draft.total
 const [amount,setAmount]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const latest=useRef(w);latest.current=w
 const provisional=w.project.working.lines.filter(l=>l.included&&l.note.startsWith('PROVISIONAL AI ALLOWANCE')).length
 async function prepare(){
  setBusy(true);setError('');const snapshot=JSON.stringify(w)
  try{const response=await fetch('/api/studio/price-draft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace:w})}),data=await response.json();if(!response.ok)throw new Error(data.error||'Could not prepare this draft.');if(JSON.stringify(latest.current)!==snapshot)throw new Error('Your project changed while pricing. Your edits are preserved; prepare the draft again.');const priced=parseWorkspace(data.workspace);if(!priced||priced.project.id!==w.project.id)throw new Error('Invalid pricing draft. Your project is unchanged.');onChange(priced);setAmount('')}
  catch(e){setError((e as Error).message)}finally{setBusy(false)}
 }
 function apply(value:number){try{const markup=markupForTotal(draft.revision,value);onChange({...w,project:revise(w.project,{lines:draft.revision.lines,markup})});setError('')}catch(e){setError((e as Error).message)}}
 return <section className="wb-card wb-simple-estimate" aria-busy={busy}>
  <p className="wb-eyebrow">YOUR PROVISIONAL ESTIMATE</p><h2>{t.cost>0?money(t.total):'Let WorkA prepare the prices'}</h2>
  <p>Total includes GST · {draft.missing?'Partial total — prepare the draft to fill missing prices.':provisional?'AI allowances included. Ready to try the draft quote.':'For the included work; confirm scope before quoting.'}</p>
  <button className={!provisional||draft.missing?'wb-primary':''} disabled={busy||!w.project.working.lines.length} onClick={()=>void prepare()}>{busy?'Preparing your estimate…':provisional?'Refresh provisional estimate':'Prepare a draft estimate →'}</button>
  <p className="wb-hint">WorkA uses recorded scope and plans to propose grouped prices and missing-work allowances. Existing prices are kept. No hundreds of fields to fill.</p>
  {busy&&<p role="status">Reviewing the plans and preparing costs. This can take a few minutes; keep this page open.</p>}
  {t.cost>0&&<><label htmlFor="estimate-price-slider">Adjust your selling price<input disabled={busy} id="estimate-price-slider" type="range" min={Math.ceil(t.cost*1.1)} max={Math.floor(t.cost*2.2)} step="1" value={Math.round(t.total)} onChange={e=>{setAmount('');apply(Number(e.target.value))}}/></label><div className="wb-slider-labels"><span>Lower price</span><span>Higher price</span></div>
   <label>Or enter total including GST<input disabled={busy} type="number" min={t.cost*1.1} max={t.cost*2.2} step="0.01" value={amount||t.total} onChange={e=>setAmount(e.target.value)} onBlur={()=>{if(amount)apply(Number(amount))}} onKeyDown={e=>{if(e.key==='Enter'&&amount){apply(Number(amount));e.currentTarget.blur()}}}/></label>
   <p>Estimated cost: {money(t.cost)} ex GST · Gross margin: {t.margin.toFixed(1)}%</p><p className="wb-hint">The slider changes selling price; estimated costs stay the same. Lowest price covers estimated costs and GST.</p></>}
  {error&&<p role="alert">{error}</p>}
  <button className={provisional&&!draft.missing?'wb-primary':''} disabled={busy||t.cost<=0} onClick={()=>{if(amount){try{markupForTotal(draft.revision,Number(amount))}catch(e){setError((e as Error).message);return}}onChange({...w,project:revise(w.project,{lines:draft.revision.lines,markup:amount?markupForTotal(draft.revision,Number(amount)):draft.revision.markup})});onReview()}}>Try the draft quote →</button><button disabled={busy} onClick={onDetails}>View breakdown</button>
  <details><summary>Assumptions and price basis</summary><p>{provisional} AI-priced items · {draft.saved} saved rates proposed · {draft.suggested} standard wall allowances proposed · {draft.missing} missing prices.</p><p>AI prices are provisional estimating allowances, not verified supplier quotes or live online averages. Recorded plan evidence informs the estimate; quantities, scope and prices still need builder review before a real quote.</p><p style={{whiteSpace:'pre-wrap'}}>{w.project.working.exclusions}</p><p>Adjusting the total does not confirm measurements or approve scope. Accepted work and actual spending remain protected.</p></details>
 </section>
}
