'use client'
import { useCallback,useEffect,useState } from 'react'
import Link from 'next/link'
import type { loadProfitControl } from '@/lib/profit-control-data'
import { tradeCategoryName } from '@/lib/trade-taxonomy'
import { Card,Metrics,api,money,pct } from './ui'
import './profitability.css'
type Data=Awaited<ReturnType<typeof loadProfitControl>>
const date=(v:string|null)=>v?new Date(`${v.slice(0,10)}T12:00:00`).toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'}):'Not recorded'
export default function ProfitControl({compact=false}:{compact?:boolean}){
  const [d,setD]=useState<Data|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('')
  const [evidence,setEvidence]=useState({worker_id:'',kind:'insurance',evidence:'',expires_on:'',confirmed:false})
  const load=useCallback(async()=>{setError('');try{setD(await api('/api/business/profit-control'))}catch(e){setError((e as Error).message)}},[])
  useEffect(()=>{void load()},[load])
  async function save(){setBusy(true);setNotice('');setError('');try{await api('/api/business/compliance',evidence);await load();setNotice('Evidence review saved');setEvidence({...evidence,confirmed:false})}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  return <section className="pi !p-0 !max-w-none" aria-label="Profit control">
    {error&&<div role="alert" className="pi-alert pi-error">{error}{d&&' Previously loaded figures may be out of date.'}<button onClick={load}>Refresh</button></div>}
    {!d&&!error&&<p role="status">Loading profit control…</p>}
    {d&&<>
      <Card title={compact?'Profit exceptions':'Profit control · live job ledgers'}>
        <Metrics values={[
          ['Forecast gross profit · confirmed jobs',money(d.totals.forecastProfit)],['Margin leakage · confirmed jobs',money(d.totals.leakage)],
          ['Unbilled change costs',money(d.totals.unbilled)],['Confirmed job forecasts',`${d.totals.confirmed} of ${d.totals.active}`],
        ]}/>
        <p className="muted mt-4">Forecast totals cover confirmed active jobs only, across their full duration. They are before business overhead and tax, and cannot be compared directly with a yearly revenue target. Refreshed {new Date(d.generatedAt).toLocaleTimeString('en-AU')}.</p>
        <div className="mt-4 space-y-3">{(compact?d.exceptions.slice(0,5):d.exceptions).map(e=><Link key={e.id} className="pi-card block" style={{color:'var(--text-primary)'}} href={e.href}>
          <span className="pi-badge">{e.priority===1?'Act now':e.priority===2?'Review soon':'Complete your inputs'}</span><h3 className="mt-2">{e.title}</h3><p>{e.detail}</p><p className="mt-2">{e.action} →</p>
        </Link>)}{d.exceptions.length===0&&<p>No exceptions found in the recorded information. Keep costs, cash and document reviews current.</p>}</div>
        {compact&&<Link className="pi-button" href="/business">Open control centre · {d.exceptions.length} exceptions →</Link>}
      </Card>
      {!compact&&<>
        <Card title="Job margin and cash"><div className="pi-scroll"><table><thead><tr><th>Job</th><th>Quoted margin</th><th>Forecast margin</th><th>Cost to finish</th><th>Forecast gross profit</th><th>Job net cash</th></tr></thead><tbody>
          {d.jobs.map(j=><tr key={j.id}><td><Link href={`/jobs/${j.id}/profitability`}>{j.address} →</Link><p className="muted">{j.status} · {j.control.complete?'Confirmed forecast':'Inputs need review'}</p></td><td>{pct(j.control.quotedMargin)}</td><td>{pct(j.control.margin)}</td><td>{money(j.control.costToComplete)}</td><td>{money(j.control.profit)}</td><td>{money(j.control.cash)}<p className="muted">As of {date(j.control.cashAsOf)}</p></td></tr>)}
        </tbody></table></div><p className="muted mt-3">Job net cash is builder-recorded receipts less payments including GST. It is separate from ex-GST profitability and is not a bank feed.</p></Card>
        <Card title="Builder Operating Profile"><p className="muted">Memory comes only from builder-confirmed completed reviews with reconciled GST and trade mappings. Comparable outcomes become suggestions in a future job’s Learning tab. Every adjustment requires approval.</p>
          {d.memory.length===0?<p className="pi-alert">No approved completed outcomes yet. Finish a job’s estimate-vs-actual review to start your operating profile.</p>:d.memory.map(m=><details key={m.jobId}><summary>{m.address} · approved {date(m.confirmedAt)}</summary><p>Quoted margin {pct(m.expectedMargin)} → actual margin {pct(m.actualMargin)}.</p><p className="muted">{m.context.jobType} · {m.context.region} · {m.context.constructionType}</p>
            <div className="pi-scroll"><table><thead><tr><th>Trade</th><th>Estimated cost</th><th>Actual cost</th><th>Variance</th></tr></thead><tbody>{m.trades.map((t:{id:number|null;estimated:number;actual:number;variance:number})=><tr key={t.id??'unclassified'}><td>{t.id===null?'Unclassified':tradeCategoryName(t.id)}</td><td>{money(t.estimated)}</td><td>{money(t.actual)}</td><td>{money(t.variance)}</td></tr>)}</tbody></table></div><Link href={`/jobs/${m.jobId}/profitability`}>Review outcome and evidence →</Link></details>)}
        </Card>
        <Card title="Program and capacity"><p className="muted">Set a job’s planned dates and lead supervisor in its profitability view. Overlaps are review prompts; they do not automatically reschedule work.</p>
          {d.jobs.filter(j=>j.live&&j.plan?.start_on).map(j=><p className="mt-3" key={j.id}><Link href={`/jobs/${j.id}/profitability`}>{j.address}</Link> · {date(j.plan!.start_on)}–{date(j.plan!.finish_on)} · {d.workers.find(w=>w.id===j.plan!.lead_worker_id)?.name??'Supervisor unassigned'}</p>)}
          {!d.jobs.some(j=>j.live&&j.plan?.start_on)&&<p>No current job dates recorded.</p>}
        </Card>
        <Card title="Subcontractor evidence"><p className="muted">Track licence, insurance, SWMS and worker-classification reviews against your existing team records. This records your evidence review; it does not determine legal compliance or superannuation liability.</p>
          {notice&&<p role="status">{notice}</p>}
          <div className="pi-grid"><label className="pi-field"><span>Team member / subcontractor</span><select value={evidence.worker_id} onChange={e=>setEvidence({...evidence,worker_id:e.target.value})}><option value="">Select a person</option>{d.workers.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
          <label className="pi-field"><span>Evidence type</span><select value={evidence.kind} onChange={e=>setEvidence({...evidence,kind:e.target.value})}>{['licence','insurance','SWMS','classification review'].map(k=><option key={k}>{k}</option>)}</select></label>
          <label className="pi-field"><span>Document reference / review notes</span><input value={evidence.evidence} maxLength={2000} onChange={e=>setEvidence({...evidence,evidence:e.target.value})}/></label>
          <label className="pi-field"><span>Expiry / next review</span><input type="date" value={evidence.expires_on} onChange={e=>setEvidence({...evidence,expires_on:e.target.value})}/></label></div>
          <label className="pi-check"><input type="checkbox" checked={evidence.confirmed} onChange={e=>setEvidence({...evidence,confirmed:e.target.checked})}/>I reviewed this evidence.</label>
          <button className="primary" disabled={busy||!evidence.worker_id||!evidence.confirmed||!evidence.evidence.trim()} onClick={save}>Save evidence review</button> <Link href="/team">Manage team →</Link>
          {d.compliance.map(c=><p className="mt-3" key={c.id}>{d.workers.find(w=>w.id===c.worker_id)?.name} · {c.kind} · {c.evidence} · review by {date(c.expires_on)}</p>)}
        </Card>
        <Card title="Pre-construction and project record"><p>Use each job’s existing estimate, Financial gate, correspondence and Ledger to review scope, exclusions, decisions and evidence before issuing a proposal. Potential plan or structural discrepancies remain drafts for builder or engineer review.</p><Link className="pi-button" href="/jobs">Open project records →</Link><p className="muted">Accounting imports and the existing Xero connection boundary remain available in Settings. No accounting connection is assumed.</p><Link href="/settings">Accounting settings →</Link></Card>
      </>}
    </>}
  </section>
}
