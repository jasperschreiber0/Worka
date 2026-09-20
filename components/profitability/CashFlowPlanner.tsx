'use client'
import { useEffect, useState } from 'react'
import { addDays, cashDate, legacyCashPlan, projectCash, validateCashPlan, type CashEntry, type CashPlan } from '@/lib/cash-plan'
import { api, Card, Field, Metrics, money, TextField } from './ui'
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
const dateLabel=(s:string)=>new Date(s).toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'})
const empty=():CashPlan=>({version:1,startOn:today(),opening:0,buffer:0,accounts:'',complete:false,entries:[]})
export default function CashFlowPlanner(){
  const [plan,setPlan]=useState<CashPlan>(empty),[saved,setSaved]=useState<CashPlan|null>(null),[revision,setRevision]=useState<string|null>(null),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[week,setWeek]=useState(0),[scenario,setScenario]=useState(''),[delay,setDelay]=useState(14),[editing,setEditing]=useState<CashEntry|null>(null),[preview,setPreview]=useState<{plan:CashPlan;warnings:string[]}|null>(null),[importDate,setImportDate]=useState(''),[file,setFile]=useState<File|null>(null)
  useEffect(()=>{api('/api/business/cash-plan').then(d=>{
    const p=d.plan??(d.legacy?.weeks?.length===13&&cashDate(d.legacy.startOn)?legacyCashPlan(d.legacy):empty())
    setPlan(p);setSaved(d.plan??null);setRevision(d.revision);setLoaded(true)
    if(!d.plan&&d.legacy) setNotice('Your weekly totals are retained as draft allowances. Confirm the account and timing before saving the detailed plan.')
  }).catch(e=>setError(e.message))},[])
  const change=(p:CashPlan)=>{setPlan({...p,complete:false});setNotice('Unsaved changes — review and save below')}
  let projection:ReturnType<typeof projectCash>|null=null, validation=''
  try{projection=projectCash(validateCashPlan(plan))}catch(e){validation=(e as Error).message}
  const alternative=projection&&scenario?projectCash(plan,{id:scenario,days:delay}):null
  const before=saved?projectCash(saved):null
  async function save(){setBusy(true);setError('');try{const d=await api('/api/business/cash-plan',{plan,revision},'PUT');setRevision(d.revision);setPlan(d.plan);setSaved(d.plan);setNotice('Cash forecast saved. Today now uses these weekly totals.')}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  async function importFile(){if(!file)return;setBusy(true);setError('');try{const form=new FormData();form.set('file',file);form.set('firstWeekEnd',importDate);const r=await fetch('/api/business/cash-plan/import',{method:'POST',body:form});const d=await r.json();if(!r.ok)throw new Error(d.error);setPreview(d)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  function exportCsv(){if(!projection)return;const rows=[['Week starting','Cash in incl GST','Cash out incl GST','Closing cash'],...projection.weeks.map(w=>[w.startOn,w.inflow,w.outflow,w.closing])];const blob=new Blob([rows.map(r=>r.join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='WorkA-cash-forecast.csv';a.click();URL.revokeObjectURL(url)}
  if(!loaded)return <Card title="Cash flow"><p role={error?'alert':'status'}>{error||'Loading your forecast…'}</p></Card>
  return <fieldset disabled={busy} style={{border:0,padding:0,margin:0,minWidth:0}}>
    <Card title="Know your next cash squeeze">
      <p className="muted">13 weeks of expected bank movements, including GST. Manual planning until an accounting connection is available.</p>
      {error&&<p role="alert" className="pi-alert pi-error">{error}</p>}{notice&&<p role="status" className="pi-alert">{notice}</p>}
      <div className="pi-grid"><TextField label="Business accounts included" value={plan.accounts} onChange={accounts=>change({...plan,accounts})}/><label className="pi-field"><span>Opening balance date / forecast starts</span><input type="date" value={plan.startOn} onChange={e=>{if(cashDate(e.target.value))change({...plan,startOn:e.target.value})}}/></label><Field label="Opening cash (start of this date)" min={-1e9} value={plan.opening} onChange={n=>change({...plan,opening:n??0})}/><Field label="Cash buffer you want to keep" value={plan.buffer} onChange={n=>change({...plan,buffer:n??0})}/></div>
      <p className="muted">Include only accounts available to this business. Exclude transfers between included accounts. Payments already reflected in opening cash belong before the forecast start.</p>
      {validation&&<p className="pi-alert">{validation}</p>}
      {projection&&<>
        <Metrics values={[[`Opening cash · ${dateLabel(plan.startOn)}`,money(plan.opening)],[`Lowest projected cash · ${dateLabel(projection.lowestOn)}`,money(projection.lowest)],['Room above your buffer',money(projection.headroom)]]}/>
        {projection.weeklyTiming&&<p className="pi-alert">Some entries are weekly totals. They are placed at week end; cash could run lower during the week. Replace these allowances with dated payments to see daily timing.</p>}
        {projection.overdue.length>0&&<p role="alert" className="pi-alert">{projection.overdue.length} entries fall before opening cash and are excluded. If still unpaid, change their expected dates; if paid, check they are included in opening cash.</p>}
        <CashChart values={projection.weeks.map(w=>w.closing)} alternate={alternative?.weeks.map(w=>w.closing)} buffer={plan.buffer}/>
        <p className="muted">Weekly closing cash. Solid: draft forecast. Dashed: late-payment scenario. Horizontal line: your buffer.</p>
        <details><summary>View all 13 weeks and choose a week</summary><div className="pi-scroll"><table><thead><tr><th>Week starting</th><th>Money in</th><th>Money out</th><th>Closing cash</th></tr></thead><tbody>{projection.weeks.map((w,i)=><tr key={w.startOn}><td><button aria-pressed={week===i} onClick={()=>setWeek(i)}>{dateLabel(w.startOn)}</button></td><td>{money(w.inflow)}</td><td>{money(w.outflow)}</td><td className={w.closing<plan.buffer?'pi-bad':''}>{money(w.closing)}</td></tr>)}</tbody></table></div></details>
        <h3 className="mt-5">Week of {dateLabel(projection.weeks[week].startOn)} · payment detail</h3>
        {projection.daily.slice(week*7,week*7+7).flatMap(d=>d.entries.map(e=><p key={`${e.id}-${d.on}`}>{dateLabel(d.on)} · {e.label} · {e.direction==='in'?'+':'−'}{money(e.amount)} <button onClick={()=>setEditing(plan.entries.find(x=>x.id===e.id)!)}>Edit{e.frequency!=='once'?' series':''}</button></p>))}
        {!projection.daily.slice(week*7,week*7+7).some(d=>d.entries.length)&&<p className="muted">No entries in this week. Confirm whether anything is missing.</p>}
        <details className="mt-4"><summary>Daily balances for the first fortnight</summary>{projection.daily.slice(0,14).map(d=><p key={d.on}>{dateLabel(d.on)} · {money(d.closing)}</p>)}</details>
      </>}
    </Card>
    <Card title="Receipts and payments">
      <p className="muted">Add each movement once. When an allowance becomes a bill, edit that entry instead of adding the bill again. Recurring entries apply the same amount through the end date.</p>
      <button className="primary" onClick={()=>setEditing({id:crypto.randomUUID(),label:'',direction:'out',amount:0,dueOn:plan.startOn,expectedOn:plan.startOn,frequency:'once',endOn:addDays(plan.startOn,90),note:'',timing:'day'})}>Add receipt or payment</button>
      {editing&&<div className="pi-card">
        <div className="pi-grid"><TextField label="What is it for?" value={editing.label} onChange={label=>setEditing({...editing,label})}/><Field label="Amount including GST" value={editing.amount} onChange={n=>setEditing({...editing,amount:n??0})}/><label className="pi-field"><span>Money</span><select value={editing.direction} onChange={e=>setEditing({...editing,direction:e.target.value as 'in'|'out'})}><option value="in">Coming in</option><option value="out">Going out</option></select></label>{(['dueOn','expectedOn'] as const).map(k=><label className="pi-field" key={k}><span>{k==='dueOn'?'Contractual due date':'Expected bank movement date'}</span><input type="date" value={editing[k]} onChange={e=>setEditing({...editing,[k]:e.target.value})}/></label>)}<label className="pi-field"><span>Repeat</span><select value={editing.frequency} onChange={e=>setEditing({...editing,frequency:e.target.value as CashEntry['frequency']})}>{['once','weekly','fortnightly','monthly'].map(f=><option key={f}>{f}</option>)}</select></label>{editing.frequency!=='once'&&<label className="pi-field"><span>Last repeat on or before</span><input type="date" value={editing.endOn} onChange={e=>setEditing({...editing,endOn:e.target.value})}/></label>}<TextField label="Evidence or note" value={editing.note} onChange={note=>setEditing({...editing,note})}/><label className="pi-field"><span>Date precision</span><select value={editing.timing} onChange={e=>setEditing({...editing,timing:e.target.value as 'day'|'week'})}><option value="day">Expected on this day</option><option value="week">Weekly allowance — timing unknown</option></select></label></div>
        {error&&<p role="alert">{error}</p>}<button onClick={()=>{try{const next={...plan,accounts:plan.accounts||'Accounts to confirm',entries:[...plan.entries.filter(e=>e.id!==editing.id),editing]};validateCashPlan(next);change({...next,accounts:plan.accounts});setEditing(null);setError('')}catch(e){setError((e as Error).message)}}}>Use in draft</button> <button onClick={()=>setEditing(null)}>Cancel edit</button>
      </div>}
      <div className="pi-scroll"><table><thead><tr><th>Payment</th><th>Expected</th><th>Amount</th><th>Repeat</th><th>Actions</th></tr></thead><tbody>{plan.entries.map(e=><tr key={e.id}><td>{e.label}<p className="muted">{e.note}</p></td><td>{dateLabel(e.expectedOn)}</td><td>{e.direction==='in'?'+':'−'}{money(e.amount)}</td><td>{e.frequency}</td><td><button onClick={()=>setEditing(e)}>Edit</button> <button onClick={()=>change({...plan,entries:plan.entries.filter(x=>x.id!==e.id)})}>Remove from draft</button></td></tr>)}</tbody></table></div>
    </Card>
    <Card title="What if a client pays late?">
      <div className="pi-grid"><label className="pi-field"><span>Receipt to delay (all repeats if recurring)</span><select value={scenario} onChange={e=>setScenario(e.target.value)}><option value="">Choose a receipt</option>{plan.entries.filter(e=>e.direction==='in').map(e=><option key={e.id} value={e.id}>{e.label}</option>)}</select></label><label className="pi-field"><span>Delay</span><select value={delay} onChange={e=>setDelay(Number(e.target.value))}>{[7,14,30,60].map(n=><option key={n} value={n}>{n} days</option>)}</select></label></div>
      {alternative&&<p className="pi-alert">Lowest cash would be {money(alternative.lowest)} on {dateLabel(alternative.lowestOn)}; room above buffer {money(alternative.headroom)}. This scenario does not change or save your base forecast. Receipts delayed beyond 13 weeks fall outside this view.</p>}
    </Card>
    <Card title="Bring across an existing cash-flow workbook">
      <p className="muted">Supports the North East “Cashflow Summary” layout. Preview 13 weeks of main-account totals; the original workbook is never changed or stored.</p>
      <label className="pi-field"><span>Excel workbook</span><input type="file" accept=".xlsx" onChange={e=>{setFile(e.target.files?.[0]??null);setPreview(null)}}/></label><label className="pi-field"><span>First week-ending date to import</span><input type="date" value={importDate} onChange={e=>{setImportDate(e.target.value);setPreview(null)}}/></label><button disabled={busy||!file||!importDate} onClick={importFile}>Preview workbook</button>
      {preview&&<div className="pi-alert"><p>Opening cash {money(preview.plan.opening)} · {dateLabel(preview.plan.startOn)} to {dateLabel(addDays(preview.plan.startOn,90))}</p><ul>{preview.warnings.map(w=><li key={w}>{w}</li>)}</ul><div className="pi-scroll"><table><thead><tr><th>Week starting</th><th>In</th><th>Out</th><th>Closing</th></tr></thead><tbody>{projectCash(preview.plan).weeks.map(w=><tr key={w.startOn}><td>{dateLabel(w.startOn)}</td><td>{money(w.inflow)}</td><td>{money(w.outflow)}</td><td>{money(w.closing)}</td></tr>)}</tbody></table></div><button onClick={()=>{change(preview.plan);setPreview(null);setScenario('');setEditing(null)}}>Replace draft with these totals</button> <button onClick={()=>setPreview(null)}>Discard import</button></div>}
    </Card>
    <Card title="Review and save">
      <p>Check client payment dates, supplier bills, wages, tax, card settlements and transfers. Confirm the opening balance against the accounts named above.</p>
      {before&&projection&&<p>Compared with your last saved plan: lowest cash changes by {money(projection.lowest-before.lowest)}; closing cash changes by {money(projection.weeks[12].closing-before.weeks[12].closing)}{saved?.startOn!==plan.startOn?' (forecast dates also changed)':''}.</p>}
      <label className="pi-check"><input type="checkbox" checked={plan.complete} onChange={e=>setPlan({...plan,complete:e.target.checked})}/>I have reviewed opening cash and all known receipts and payments for these 13 weeks.</label>
      <p className="muted">{plan.complete?'Based on your reviewed assumptions; payment timing can still change.':'Incomplete forecast — missing payments can make cash look better than it is.'}</p>
      <button className="primary" disabled={busy||!!validation||!!editing} onClick={save}>Save cash forecast</button> <button disabled={!projection} onClick={exportCsv}>Export weekly CSV for Excel</button>
    </Card>
  </fieldset>
}
function CashChart({values,alternate,buffer}:{values:number[];alternate?:number[];buffer:number}){
  const low=Math.min(0,buffer,...values,...(alternate??[])), high=Math.max(1,buffer,...values,...(alternate??[])), y=(v:number)=>150-(v-low)/(high-low)*125
  const points=(v:number[])=>v.map((n,i)=>`${35+i*48},${y(n)}`).join(' ')
  return <svg viewBox="0 0 650 185" role="img" aria-label="Weekly closing cash forecast; exact amounts in the table below" style={{width:'100%',marginTop:24}}><line x1="35" x2="611" y1={y(buffer)} y2={y(buffer)} stroke="var(--text-tertiary)"/><polyline points={points(values)} fill="none" stroke="var(--orange-primary)" strokeWidth="3"/>{alternate&&<polyline points={points(alternate)} fill="none" stroke="var(--status-blue)" strokeWidth="3" strokeDasharray="6 4"/>}<text x="35" y="178" fill="var(--text-secondary)" fontSize="12">Week 1</text><text x="560" y="178" fill="var(--text-secondary)" fontSize="12">Week 13</text></svg>
}
