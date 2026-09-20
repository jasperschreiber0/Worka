'use client'
import { useCallback,useEffect,useState } from 'react'
import Link from 'next/link'
import { Card,Field,Metrics,api,money,pct } from './ui'
import type { ControlPlan,jobControl } from '@/lib/profit-control'
type Plan=Pick<ControlPlan,'cash_received'|'cash_paid'|'cash_as_of'|'start_on'|'finish_on'|'lead_worker_id'>
const empty:Plan={cash_received:null,cash_paid:null,cash_as_of:null,start_on:null,finish_on:null,lead_worker_id:null}
export default function JobControl({jobId}:{jobId:string}){
  const [plan,setPlan]=useState<Plan>(empty),[control,setControl]=useState<ReturnType<typeof jobControl>|null>(null),[revision,setRevision]=useState(0),
    [workers,setWorkers]=useState<{id:string;name:string}[]>([]),[confirm,setConfirm]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false)
  const load=useCallback(async()=>{try{const d=await api(`/api/jobs/${jobId}/control-plan`);setPlan(d.plan??empty);setControl(d.control);setRevision(d.revision);setWorkers(d.workers);setConfirm(false)}catch(e){setError((e as Error).message)}},[jobId])
  useEffect(()=>{void load()},[load])
  async function save(){setBusy(true);setError('');setNotice('');try{await api(`/api/jobs/${jobId}/control-plan`,{...plan,revision,confirm},'PUT');await load();setNotice('Job control saved. Forecast confirmation is tied to the current financial records.')}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  return <Card title="Forecast · cash · capacity">
    {error&&<p role="alert" className="pi-alert pi-error">{error}</p>}{notice&&<p role="status" className="pi-alert">{notice}</p>}
    {control&&<><Metrics values={[
      ['Original quoted margin',pct(control.quotedMargin)],['Forecast margin',pct(control.margin)],['Forecast gross profit',money(control.profit)],
      ['Incurred costs',money(control.actual)],['Outstanding commitments',money(control.commitments)],['Other work remaining',money(control.remaining)],
      ['Cost to complete',money(control.costToComplete)],['Margin leakage',money(control.leakage)],['Unbilled change costs',money(control.unbilled)],
      ['Recorded job net cash',money(control.cash)],
    ]}/><p className="muted mt-4">Financials exclude GST. Job cash includes GST and uses your reconciled receipts and payments; it is not a connected bank balance. Unbilled change costs track potential recovery, not an extra cost to subtract.</p>
    {!control.complete&&<p className="pi-alert">Forecast incomplete: {control.reasons.join('. ')}. Capture the original estimate and confirm GST in Financial gate, then review Job Money.</p>}
    <Link className="pi-button" href={`/jobs/${jobId}`}>Open Job Money to update costs →</Link>
    <label className="pi-check"><input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>I have reviewed incurred costs, outstanding commitments and all other costs to finish. Each cost appears once; no remaining entries means no other work cost remains.</label>
    <p className="muted">Saving without this confirmation leaves the forecast unconfirmed. New costs, labour, scope changes or financial assumptions invalidate a previous confirmation.</p>
    <details className="mt-4"><summary>Record job cash and planned capacity</summary><div className="pi-grid">
      <Field nullable label="Cash received to date, including GST" value={plan.cash_received} onChange={v=>setPlan({...plan,cash_received:v})}/>
      <Field nullable label="Cash paid to date, including GST" value={plan.cash_paid} onChange={v=>setPlan({...plan,cash_paid:v})}/>
      {([['cash_as_of','Cash reconciled as of'],['start_on','Planned start'],['finish_on','Planned finish']] as const).map(([key,label])=><label className="pi-field" key={key}><span>{label}</span><input type="date" value={plan[key]??''} onChange={e=>setPlan({...plan,[key]:e.target.value||null})}/></label>)}
      <label className="pi-field"><span>Lead supervisor</span><select value={plan.lead_worker_id??''} onChange={e=>setPlan({...plan,lead_worker_id:e.target.value||null})}><option value="">Unassigned</option>{workers.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
    </div><p className="muted">Dates are planning inputs. Overlapping supervisor assignments surface on Today; no trade rescheduling is automatic.</p></details>
    <button className="primary" disabled={busy} onClick={save}>{busy?'Saving…':'Save job control'}</button></>}
  </Card>
}
