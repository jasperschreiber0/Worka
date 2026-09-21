'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { loadProfitControl } from '@/lib/profit-control-data'
import { targetMarkup } from '@/lib/today'
import './today.css'

type Data = Awaited<ReturnType<typeof loadProfitControl>>
const money = (n: number | null) => n === null ? 'Not confirmed' : new Intl.NumberFormat('en-AU', {style:'currency',currency:'AUD',maximumFractionDigits:0}).format(n)
const pct = (n: number | null) => n === null ? '—' : `${n.toFixed(1)}%`

export default function TodayControl() {
  const [data,setData] = useState<Data|null>(null)
  const [error,setError] = useState('')
  const [loading,setLoading] = useState(true)
  const [question,setQuestion] = useState('')
  const [askError,setAskError] = useState('')
  const [showAll,setShowAll] = useState(false)
  const router = useRouter()
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const response = await fetch('/api/business/profit-control', {cache:'no-store'})
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not refresh Today.')
      setData(result)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not refresh Today.') }
    finally { setLoading(false) }
  },[])
  useEffect(()=>{void load()},[load])
  function ask(event: FormEvent) {
    event.preventDefault(); setAskError('')
    if (!question.trim()) return
    try {
      // A draft only: navigation must never issue an AI call or send a message.
      sessionStorage.setItem('worka_today_question',question.trim())
      router.push('/chat?action=today_question')
    } catch { setAskError('Could not carry your draft across. Open Ask WorkA and enter your question there.') }
  }
  const business = data?.business
  const markup = targetMarkup(business?.viable ? business.targetMargin : null)
  const setup = data ? [
    {done:Boolean(business?.viable),title:'Set your overheads and profit target',detail:'Include office wages and your management wage. Keep labour already costed to jobs out of overheads.',href:'/business#financial-profile',action:'Enter overheads'},
    {done:data.totals.confirmed>0,title:'Confirm a job forecast',detail:'Review the original estimate, GST, incurred costs, commitments and remaining work. Enter costs manually or import a spreadsheet.',href:data.jobs.find(j=>j.live)?.id ? `/jobs/${data.jobs.find(j=>j.live)!.id}/profitability` : '/jobs?new=1',action:data.jobs.some(j=>j.live)?'Review a job':'Create a job'},
    {done:Boolean(data.cash?.complete && data.cash.startOn && !data.exceptions.some(e=>e.id==='cash:review')),title:'Plan the next 13 weeks of cash',detail:'Enter opening cash, expected receipts and payments. An accounting connection is optional; these figures are a manual plan.',href:'/business#cash-flow',action:'Enter cash plan'},
  ] : []
  const incomplete = setup.filter(s=>!s.done)
  const entries = data?.exceptions ?? []
  return <main className="worka-today">
    <header className="today-heading"><div><h1>Today</h1><p>{data ? new Date(data.generatedAt).toLocaleDateString('en-AU',{timeZone:'Australia/Sydney',weekday:'long',day:'numeric',month:'long'}) : 'Your business, jobs and next actions'}</p></div><Link className="today-primary" href="/jobs?new=1">New job</Link></header>
    {error && <div role="alert" className="today-error"><p>{error} {data && 'Previously loaded figures may be out of date.'}</p><button disabled={loading} onClick={load}>Try again</button></div>}
    {!data && loading && <p role="status">Loading your profit picture…</p>}
    {data && <>
      {incomplete.length>0 && <section className="today-setup" aria-labelledby="setup-title">
        <div className="today-section-heading"><div><span className="today-eyebrow">YOUR PROFIT PICTURE</span><h2 id="setup-title">{setup.every(s=>!s.done)?'Get the numbers working for you':'Complete your profit picture'}</h2></div><span>{setup.length-incomplete.length} of {setup.length} ready</span></div>
        <p>Keep estimating and managing jobs while you complete these steps. WorkA shows what is known and what still needs your review.</p>
        <ol>{setup.map((s,i)=><li key={s.title}><span className={s.done?'today-step done':'today-step'} aria-label={s.done?'Complete':`Step ${i+1}`}>{s.done?'✓':i+1}</span><div><h3>{s.title}</h3><p>{s.detail}</p>{!s.done && <Link href={s.href}>{s.action} →</Link>}</div></li>)}</ol>
      </section>}

      <section className="today-hero" aria-labelledby="forecast-title">
        <div className="today-section-heading"><h2 id="forecast-title">Forecast gross profit</h2><span className="today-tag">Confirmed open-job forecasts</span></div>
        <div className={`today-figure ${data.totals.forecastProfit===null?'unconfirmed':data.totals.forecastProfit<0?'negative':''}`}>{money(data.totals.forecastProfit)}<span>before business overhead and tax</span></div>
        <p>{data.totals.confirmed} of {data.totals.active} open jobs have confirmed forecasts. These figures cover each job’s full duration, including quoting jobs, and are not profit earned this financial year.</p>
        <div className="today-coverage" role="progressbar" aria-label="Open jobs with confirmed forecasts" aria-valuemin={0} aria-valuemax={Math.max(1,data.totals.active)} aria-valuenow={data.totals.confirmed}><span style={{width:`${data.totals.active?data.totals.confirmed/data.totals.active*100:0}%`}}/></div>
        <div className="today-hero-foot"><span>{money(data.totals.leakage)} forecast profit reduction against original estimates</span><Link href="/business">Review job forecasts →</Link></div>
      </section>

      <section className="today-pricing" aria-label="Your pricing target"><div>
        {markup!==null && business ? <><p>At your planning revenue of <strong>{money(business.revenue)}</strong>, overheads need <strong>{pct(business.minimumMargin)}</strong> of sales. Your profit target requires <strong>{pct(business.targetMargin)} gross margin</strong> — equivalent to <strong>{pct(markup)} markup on cost</strong>.</p>
          <details><summary>How this is calculated</summary><p>Required margin = (annual overheads + target profit) ÷ planning revenue. Markup = margin ÷ (100 − margin) × 100. These are business planning targets, not your measured average quote pricing.</p><p>Annual overheads: {money(business.overhead)} · Target profit: {money(business.targetProfit)}. Quote figures exclude GST.</p></details></> : <p>What should you charge? Set your overheads, planning revenue and profit target to calculate the margin your prices need to cover.</p>}
      </div><Link className="today-secondary" href="/business#financial-profile">Review pricing</Link></section>

      <section className="today-metrics" aria-label="Business indicators">
        {[
          {label:'Active jobs',value:String(data.operations.activeJobs),detail:'Jobs currently marked active',href:'/jobs'},
          {label:'Unbilled change costs',value:money(data.totals.unbilled),detail:'Recorded scope changes only',href:'#unbilled'},
          {label:'Overdue invoices',value:money(data.operations.overdueTotal),detail:`${data.operations.overdueCount} issued invoices · recorded amounts`,href:'#invoices'},
          {label:'Variations awaiting approval',value:String(data.operations.pendingCount),detail:'Pending charges excluded from revenue',href:'#variations'},
        ].map(m=><Link key={m.label} className="today-metric" href={m.href} onClick={()=>setShowAll(true)}><span>{m.label}</span><strong>{m.value}</strong><small>{m.detail}</small></Link>)}
      </section>

      <section aria-labelledby="attention-title"><div className="today-section-heading"><h2 id="attention-title">Needs attention</h2><span>{entries.length} items · urgency, age, then known impact</span></div>
        <div className="today-attention">{(showAll?entries:entries.slice(0,8)).map(e=><article key={e.id}>
          <span className={`today-dot priority-${e.priority}`} aria-hidden="true"/><div><span className="today-eyebrow">{e.priority===1?'Act now':e.priority===2?'Review soon':'Complete inputs'}</span><h3>{e.title}</h3><p>{e.detail}</p>{e.dueOn && <small>Oldest due {new Date(`${e.dueOn}T12:00:00`).toLocaleDateString('en-AU')}</small>}</div><Link className="today-secondary" href={e.href}>{e.action} →</Link>
        </article>)}{entries.length===0 && <p className="today-empty">No exceptions found in the recorded information. Keep costs and cash assumptions current.</p>}</div>
        {entries.length>8 && <button className="today-more" onClick={()=>setShowAll(!showAll)}>{showAll?'Show fewer':`Show all ${entries.length} items`}</button>}
      </section>

      <section className="today-detail-links" aria-label="Financial records">
        {(['unbilled','invoices','variations'] as const).map(kind=>{
          const matches=entries.filter(e=>e.id.endsWith(`:${kind}`))
          return <details id={kind} key={kind}><summary>{kind==='unbilled'?'Unbilled change costs by job':kind==='invoices'?'Overdue invoices by job':'Pending variations by job'}</summary>
            {matches.length?matches.map(e=><p key={e.id}><Link href={e.href}>{e.title} →</Link>{e.impact!==undefined && ` · ${money(e.impact)}`}</p>):<p>None found in the recorded information.</p>}
          </details>
        })}
      </section>
      <footer className="today-freshness"><span>Refreshed {new Date(data.generatedAt).toLocaleTimeString('en-AU',{hour:'numeric',minute:'2-digit'})} · Manual records and confirmed forecasts</span><button disabled={loading} onClick={load}>{loading?'Refreshing…':'Refresh'}</button></footer>
    </>}
    <div className="today-ask"><form onSubmit={ask}><span className="today-mark" aria-hidden="true">W</span><label className="sr-only" htmlFor="today-question">Draft a question for WorkA</label><input id="today-question" maxLength={2000} value={question} onChange={e=>setQuestion(e.target.value)} placeholder="Ask WorkA about your jobs…"/><button disabled={!question.trim()} type="submit">Open draft →</button></form><small>Review and send your question in <Link href="/chat">Ask WorkA</Link>.</small>{askError && <p role="alert">{askError}</p>}</div>
  </main>
}
