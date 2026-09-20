'use client'
import './profitability.css'
import {useCallback,useEffect,useState} from 'react'
import {api,Card,Field,TextField,money} from './ui'
type Cost={id:string;description:string;amount:number;cost_kind:string;incurred_on:string}
type Hours={id:string;note:string|null;hours:number;hourly_rate:number|null;work_date:string}
export default function FinancialCorrections({jobId,onSaved}:{jobId:string;onSaved?:()=>void}){
 const [data,setData]=useState<{costs:Cost[];hours:Hours[];revision:number}|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[id,setId]=useState(''),[action,setAction]=useState('correct_cost'),[amount,setAmount]=useState(0),[hours,setHours]=useState(0),[rate,setRate]=useState<number|null>(null),[kind,setKind]=useState('incurred'),[date,setDate]=useState(''),[reason,setReason]=useState('')
 const url=`/api/jobs/${jobId}/financial-records`
 const load=useCallback(async()=>{try{setError('');setData(await api(url))}catch(e){setError((e as Error).message)}},[url])
 useEffect(()=>{void load()},[load])
 async function save(){if(!data)return;setBusy(true);setError('');try{await api(url,{id,action,revision:data.revision,reason,values:{amount,cost_kind:kind,incurred_on:date,hours,hourly_rate:rate}});setId('');setReason('');await load();onSaved?.();setNotice('Correction saved with history. Review and confirm the updated forecast or completed outcome.')}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 return <Card title="Correct costs · settle commitments · repair labour">
 <p className="muted">A bill replaces its commitment here. A partial bill reduces the outstanding amount and creates an incurred entry; it does not add the same cost twice. This records the cost, not a bank payment.</p>
 {error&&<p role="alert" className="pi-alert">{error} <button onClick={load}>Reload records</button></p>}{notice&&<p role="status">{notice}</p>}
 {!data?<p>Loading records…</p>:<>
 <details open><summary>Costs and outstanding commitments ({data.costs.length})</summary><div className="pi-scroll"><table><thead><tr><th>Cost</th><th>Amount</th><th>Type</th><th>Action</th></tr></thead><tbody>{data.costs.map(c=><tr key={c.id}><td>{c.description}</td><td>{money(Number(c.amount))}</td><td>{c.cost_kind??'incurred'}</td><td><button disabled={busy} onClick={()=>{setId(c.id);setAction('correct_cost');setAmount(Number(c.amount));setKind(c.cost_kind??'incurred');setDate(c.incurred_on);setReason('')}}>Correct</button>{['committed','remaining'].includes(c.cost_kind)&&Number(c.amount)>0&&<button disabled={busy} onClick={()=>{setId(c.id);setAction('settle_cost');setAmount(Number(c.amount));setDate(new Date().toISOString().slice(0,10));setReason('')}}>Record bill against this</button>}</td></tr>)}</tbody></table></div></details>
 <details><summary>All labour entries ({data.hours.length})</summary>{data.hours.map(h=><p key={h.id}>{h.work_date} · {h.note||'Site hours'} · {h.hours} h · {h.hourly_rate===null?'Rate missing':`${money(Number(h.hourly_rate))}/h`} <button disabled={busy} onClick={()=>{setId(h.id);setAction('correct_hours');setHours(Number(h.hours));setRate(h.hourly_rate===null?null:Number(h.hourly_rate));setReason('')}}>Correct hours or rate</button></p>)}</details>
 {id&&<fieldset disabled={busy} className="pi-card"><legend>{action==='settle_cost'?'Replace outstanding cost with actual bill':action==='correct_hours'?'Correct recorded labour':'Correct cost'}</legend>
 {action==='correct_hours'?<><Field label="Hours" value={hours} onChange={n=>setHours(n??0)}/><Field nullable label="Hourly cost excluding GST" value={rate} onChange={setRate}/></>:<><Field label="Amount excluding GST" value={amount} onChange={n=>setAmount(n??0)}/>{action==='settle_cost'?<label className="pi-field"><span>Bill date</span><input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>:<label className="pi-field"><span>Cost type</span><select value={kind} onChange={e=>setKind(e.target.value)}>{['incurred','committed','remaining'].map(k=><option key={k}>{k}</option>)}</select><small>To void an incorrect entry, set its amount to zero; the original remains in history.</small></label>}</>}
 <TextField label="Reason / invoice reference" value={reason} onChange={setReason}/><button className="primary" disabled={reason.trim().length<5||(action==='correct_hours'&&rate===null)} onClick={save}>Save correction</button> <button onClick={()=>setId('')}>Cancel</button>
 </fieldset>}
 </>}
 </Card>
}
