'use client'

import { useEffect, useState } from 'react'
import { TRADE_CATEGORIES } from '@/lib/trade-taxonomy'
import TasksTab from '@/components/job/tabs/TasksTab'
import type { JobTask, JobWorkerRef } from '@/lib/job-snapshot-demo'

export default function SitePanel({ jobId, builderId }: { jobId: string; builderId: string }) {
  const [tasks, setTasks] = useState<JobTask[]>([])
  const [workers, setWorkers] = useState<JobWorkerRef[]>([])
  const [hours, setHours] = useState<Array<{ id: string; hours: number; hourly_rate?: number | null; work_date: string; note?: string | null; worker_id?: string | null }>>([])
  const [entry, setEntry] = useState({ hours: '', work_date: new Date().toISOString().slice(0, 10), worker_id: '', note: '', trade_category_id: '' })
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const read = async (url: string) => { const response = await fetch(url); if (!response.ok) throw new Error('Could not load site records. Refresh to try again.'); return response.json() }
    Promise.all([read(`/api/jobs/${jobId}/tasks`), read('/api/workers'), read(`/api/jobs/${jobId}/hours`)]).then(([taskData, workerData, hourData]) => {
      setTasks(taskData.tasks ?? [])
      setWorkers((workerData.workers ?? []).map((worker: { id: string; name: string }) => ({ id: worker.id, name: worker.name })))
      setHours(hourData.hours ?? [])
    }).catch(() => setError('Could not load site records. Refresh to try again.')).finally(() => setLoading(false))
  }, [jobId])
  async function addHours() {
    const amount = Number(entry.hours); if (!Number.isFinite(amount) || amount <= 0 || amount > 24) { setError('Enter more than zero and no more than 24 hours.'); return }
    setSaving(true)
    setError(null)
    try {
    const response = await fetch(`/api/jobs/${jobId}/hours`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...entry, hours: amount, trade_category_id: entry.trade_category_id ? Number(entry.trade_category_id) : null }) })
    const data = await response.json(); if (!response.ok || !data.hour) throw new Error(data.error ?? 'Could not save hours. Try again.')
    setHours(current => [data.hour, ...current]); setEntry(current => ({ ...current, hours: '', note: '' }))
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save hours. Try again.') }
    finally { setSaving(false) }
  }
  if (loading) return <p role="status" className="p-5">Loading site records…</p>
  const totalHours = hours.reduce((sum, row) => sum + Number(row.hours), 0)
  return <div className="card"><div className="p-5 border-b" style={{ borderColor: 'var(--bg-border)' }}><h2 className="font-semibold">Run the site</h2><p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>Keep today’s site actions and responsibilities in one place.</p></div><div role="alert" className="px-4">{error}</div><TasksTab tasks={tasks} workers={workers} jobId={jobId} builderId={builderId} /><div className="p-4 border-t" style={{ borderColor: 'var(--bg-border)' }}><div className="flex items-center justify-between"><h3 className="font-semibold">Labour hours</h3><span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{totalHours.toFixed(1)} hours logged</span></div><div className="grid grid-cols-2 gap-2 mt-3"><input aria-label="Work date" type="date" value={entry.work_date} onChange={event => setEntry({ ...entry, work_date: event.target.value })} className="p-2 rounded-md" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--bg-border)' }} /><input aria-label="Hours worked" type="number" min="0.25" max="24" step="0.25" placeholder="Hours" value={entry.hours} onChange={event => setEntry({ ...entry, hours: event.target.value })} className="p-2 rounded-md" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--bg-border)' }} /></div><div className="flex gap-2 mt-2"><select aria-label="Worker" value={entry.worker_id} onChange={event => setEntry({ ...entry, worker_id: event.target.value })} className="flex-1 p-2 rounded-md" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--bg-border)' }}><option value="">Worker (optional)</option>{workers.map(worker => <option key={worker.id} value={worker.id}>{worker.name}</option>)}</select><button className="btn-primary px-3 py-2 text-sm" disabled={saving || !entry.hours} onClick={() => void addHours()}>{saving ? 'Saving…' : 'Log hours'}</button></div><label className="block mt-3 text-sm">Trade<select className="input w-full" value={entry.trade_category_id} onChange={event => setEntry({ ...entry, trade_category_id: event.target.value })}><option value="">Choose trade</option>{TRADE_CATEGORIES.map(trade => <option key={trade.id} value={trade.id}>{trade.name}</option>)}</select></label><label className="block mt-3 text-sm">Work notes<input value={entry.note} onChange={event => setEntry({ ...entry, note: event.target.value })} maxLength={2000} className="input w-full mt-1" placeholder="What work was done?" /></label><ul className="mt-4 space-y-2">{hours.map(row => <li key={row.id} className="text-sm border-t py-2"><strong>{row.hours} hours</strong> · {row.work_date} · {workers.find(worker => worker.id === row.worker_id)?.name ?? 'Unassigned'}{row.note && <p>{row.note}</p>}<p>{row.hourly_rate == null ? 'Rate missing — set a worker rate before logging future hours.' : `Labour value: $${(row.hours * row.hourly_rate).toFixed(2)}`}</p></li>)}</ul></div></div>
}


