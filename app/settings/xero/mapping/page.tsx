'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import AppShell from '@/components/shell/AppShell'
import { TRADE_CATEGORIES } from '@/lib/trade-taxonomy'

type Item = { id: string; item_type: string; description: string; amount: number | null; item_date: string | null; job_id: string | null; trade_category_id?: number | null; status: string; suggested_job_id?: string | null; suggestion_reason?: string | null; suggestion_confidence?: number | null }
type Job = { id: string; address: string; status: string }
const money = (amount: number | null) => amount == null ? '' : new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(amount)

export default function XeroMappingPage() {
  const [items, setItems] = useState<Item[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => { Promise.all([fetch('/api/xero/import-items').then(r => r.json()), fetch('/api/jobs').then(r => r.json())]).then(([xero, jobData]) => { setItems(xero.items ?? []); setJobs(jobData.jobs ?? []) }).catch(() => setMessage('Could not load Xero items.')) }, [])
  async function decide(item: Item, status: 'mapped' | 'ignored' | 'unmatched', job_id: string | null, trade_category_id: number | null = item.trade_category_id ?? null) {
    const response = await fetch('/api/xero/import-items', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, status, job_id, trade_category_id }) })
    if (!response.ok) { setMessage('Could not save this decision.'); return }
    setItems(current => current.map(row => row.id === item.id ? { ...row, status, job_id, trade_category_id } : row))
  }
  async function importItem(item: Item) {
    const response = await fetch('/api/xero/import-items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) })
    if (!response.ok) { setMessage('Could not import this item.'); return }
    setItems(current => current.filter(row => row.id !== item.id)); setMessage('Imported into Worka.')
  }
  const pending = items.filter(item => item.status === 'unmatched')
  const mapped = items.filter(item => item.status === 'mapped')
  return <AppShell><main className="max-w-3xl mx-auto px-4 sm:px-8 py-8" style={{ color: 'var(--text-primary)' }}>
    <Link href="/settings/xero" className="text-sm underline">← Xero settings</Link>
    <h1 className="text-2xl font-semibold mt-6">Review Xero items</h1>
    <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>Choose the Worka job for each record. Nothing changes job money until you make a choice.</p>
    {message && <p className="mt-4" style={{ color: 'var(--status-amber)' }}>{message}</p>}
    <div className="space-y-3 mt-6">{pending.map(item => <div key={item.id} className="card p-4">
      <div className="flex items-start justify-between gap-4"><div><p className="font-medium">{item.description}</p><p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{item.item_type} {item.item_date ? `· ${item.item_date}` : ''} {money(item.amount)}</p></div><button className="text-sm underline" onClick={() => void decide(item, 'ignored', null)}>Ignore</button></div>
      {item.suggested_job_id && <div className="mt-4 p-3 rounded-md text-sm" style={{ background: 'rgba(33,150,243,0.1)', color: 'var(--status-blue)' }}>Suggested match: {item.suggestion_reason} ({Math.round((item.suggestion_confidence ?? 0) * 100)}% confidence). { (item.suggestion_confidence ?? 0) >= 0.8 ? <button className="underline ml-1" onClick={() => void decide(item, 'mapped', item.suggested_job_id!)}>Use suggestion</button> : <span>Please check the job below.</span>}</div>}
      <select aria-label={`Map ${item.description} to a job`} defaultValue="" onChange={event => { if (event.target.value) void decide(item, 'mapped', event.target.value) }} className="w-full mt-4 p-3 rounded-md" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--bg-border)' }}><option value="">Choose a job…</option>{jobs.map(job => <option key={job.id} value={job.id}>{job.address}</option>)}</select>
      {item.item_type === 'bill' && <select aria-label={`Choose cost category for ${item.description}`} defaultValue={item.trade_category_id ?? ''} onChange={event => void decide(item, item.job_id ? 'mapped' : 'unmatched', item.job_id, event.target.value ? Number(event.target.value) : null)} className="w-full mt-3 p-3 rounded-md" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--bg-border)' }}><option value="">Choose a cost category (optional)…</option>{TRADE_CATEGORIES.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select>}
    </div>)}{pending.length === 0 && <div className="card p-5"><p>No Xero items need review.</p><Link href="/settings/xero" className="inline-block mt-3 underline">Back to Xero</Link></div>}</div>
    {mapped.length > 0 && <div className="mt-6"><p className="text-sm" style={{ color: 'var(--status-green)' }}>{mapped.length} item(s) mapped and ready for import.</p><div className="space-y-2 mt-3">{mapped.map(item => <div key={item.id} className="card p-4 flex items-center justify-between gap-4"><span className="text-sm">{item.description}</span><button className="btn-primary px-3 py-2 text-sm" onClick={() => void importItem(item)}>Import into job</button></div>)}</div></div>}
  </main></AppShell>
}
