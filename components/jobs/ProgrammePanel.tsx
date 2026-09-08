'use client'
import { useEffect, useState } from 'react'

type Milestone = { id: string; title: string; due_date: string | null; completed_at: string | null }
export default function ProgrammePanel({ jobId }: { jobId: string }) {
  const [rows, setRows] = useState<Milestone[]>([])
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const endpoint = `/api/jobs/${jobId}/milestones`
  useEffect(() => {
    let active = true
    fetch(endpoint).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); return data }).then(data => { if (active) setRows(data.milestones) }).catch(() => { if (active) setError('Could not load milestones. Refresh to try again.') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [endpoint])
  async function save(row?: Milestone) {
    setBusy(true); setError('')
    try {
      const response = await fetch(endpoint, { method: row ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row ? { id: row.id, completed: !row.completed_at } : { title, due_date: date || null }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? 'Could not save milestone.')
      setRows(current => row ? current.map(item => item.id === row.id ? data.milestone : item) : [...current, data.milestone])
      if (!row) { setTitle(''); setDate('') }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save milestone.') }
    finally { setBusy(false) }
  }
  return <section className="card p-4 mb-4">
    <h2 className="font-semibold">Programme</h2>
    <p className="text-sm mt-1 mb-3">Plan key stages and mark them complete as the job progresses.</p>
    {error && <p role="alert">{error}</p>}
    {loading ? <p role="status">Loading milestones…</p> : <ul className="space-y-2">{rows.map(row => <li key={row.id} className="flex items-center justify-between gap-3 border-b py-2"><div><p className={row.completed_at ? 'line-through opacity-60' : ''}>{row.title}</p><p className="text-xs">{row.due_date ?? 'No date set'}{!row.completed_at && row.due_date && row.due_date < new Date().toLocaleDateString('en-CA') ? ' · Overdue' : ''}</p></div><button className="btn-secondary px-3 min-h-11" disabled={busy} onClick={() => void save(row)}>{row.completed_at ? 'Reopen' : 'Complete'}</button></li>)}{!rows.length && <li className="text-sm">No milestones yet. Add your next stage below.</li>}</ul>}
    <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void save() }}>
      <label className="block text-sm">Stage<input className="input w-full mt-1" required maxLength={200} placeholder="e.g. Framing complete" value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label className="block text-sm">Due date<input className="input w-full mt-1" type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
      <button className="btn-primary px-4 min-h-11" disabled={busy || loading}>{busy ? 'Saving…' : 'Add milestone'}</button>
    </form>
  </section>
}
