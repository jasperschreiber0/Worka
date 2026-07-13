'use client'
import React, { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'

interface HistoryRecord {
  id: string
  job_type: string | null
  finish_level: string | null
  region: string | null
  suburb: string | null
  floor_area_m2: number | null
  storeys: number | null
  wet_areas: number | null
  project_summary: string | null
  total_cost: number | null
  cost_per_m2: number | null
}

const aud = (n: number) => n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 })
const titleize = (s: string | null) => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—')

export default function HistoryPage() {
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [demo, setDemo] = useState(false)
  const [busy, setBusy] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [editVal, setEditVal] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function saveArea(id: string) {
    const area = Number(editVal)
    if (!area || area <= 0) { setEditId(null); return }
    setSavingId(id)
    try {
      const res = await fetch('/api/estimation/history', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, floor_area_m2: area }),
      })
      if (res.ok) {
        setRecords((prev) => prev.map((r) =>
          r.id === id
            ? { ...r, floor_area_m2: area, cost_per_m2: r.total_cost ? Math.round(r.total_cost / area) : null }
            : r
        ))
      }
    } catch { /* leave the row unchanged */ }
    finally { setSavingId(null); setEditId(null) }
  }

  useEffect(() => {
    fetch('/api/estimation/history')
      .then((r) => r.json())
      .then((d: { records?: HistoryRecord[]; demo?: boolean }) => {
        setRecords(d.records ?? [])
        setDemo(Boolean(d.demo))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const uploadOne = useCallback((file: File) => {
    const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf'
    if (!isPdf) { setError('Upload a PDF quote or trade breakdown.'); return }
    setError(null)
    setBusy((n) => n + 1)
    const form = new FormData()
    form.append('file', file)
    fetch('/api/estimation/history', { method: 'POST', body: form })
      .then((r) => r.json())
      .then((d: { record?: HistoryRecord; saved?: boolean; demo?: boolean; error?: string }) => {
        if (d.error || !d.record) { setError(d.error ?? 'Could not read that document.'); return }
        setRecords((prev) => [d.record as HistoryRecord, ...prev])
        if (d.demo) setDemo(true)
      })
      .catch(() => setError('Upload failed — please try again.'))
      .finally(() => setBusy((n) => n - 1))
  }, [])

  function handleFiles(files: FileList | null) {
    if (!files) return
    Array.from(files).forEach(uploadOne)
  }

  const totalValue = records.reduce((s, r) => s + (r.total_cost ?? 0), 0)

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-shell)' }}>
      <header style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--bg-border)' }}>
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link
            href="/estimate"
            className="flex items-center justify-center w-8 h-8 rounded-[6px]"
            style={{ color: 'var(--text-secondary)' }}
            title="Back to estimate"
            aria-label="Back to estimate"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Your job history</h1>
          <p className="mt-1.5" style={{ color: 'var(--text-secondary)' }}>
            Drop in past quotes and trade breakdowns. WorkA reads each one&rsquo;s size, type and price — the more you add, the sharper your estimates.
          </p>
        </div>

        {/* Dropzone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
          onClick={() => inputRef.current?.click()}
          className="rounded-2xl cursor-pointer flex flex-col items-center justify-center gap-2 py-10 px-4 mb-3 border-2 border-dashed transition-colors"
          style={dragOver ? { borderColor: 'var(--orange-primary)', background: 'rgba(255,107,43,0.08)' } : { borderColor: 'var(--bg-border)', background: 'var(--bg-surface)' }}
        >
          <svg className="w-8 h-8" style={{ color: dragOver ? 'var(--orange-primary)' : 'var(--text-tertiary)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          </svg>
          <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Drop past job PDFs here, or click to browse</p>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Priced quotes, trade breakdowns, contract estimates — add several at once</p>
          <input ref={inputRef} type="file" accept=".pdf,application/pdf" multiple className="sr-only" onChange={(e) => handleFiles(e.target.files)} />
        </div>

        {busy > 0 && (
          <div className="rounded-xl px-4 py-3 mb-3 flex items-center gap-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)' }}>
            <svg className="w-4 h-4 animate-spin" style={{ color: 'var(--orange-primary)' }} fill="none" viewBox="0 0 24 24" aria-hidden="true">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Reading {busy} document{busy !== 1 ? 's' : ''}…</span>
          </div>
        )}
        {error && (
          <p className="mb-3 text-xs rounded-lg px-3 py-2" style={{ color: 'var(--status-amber)', background: 'rgba(255,152,0,0.1)', border: '1px solid rgba(255,152,0,0.2)' }}>{error}</p>
        )}
        {demo && (
          <p className="mb-3 text-xs rounded-lg px-3 py-2" style={{ color: 'var(--status-amber)', background: 'rgba(255,152,0,0.1)', border: '1px solid rgba(255,152,0,0.2)' }}>
            Demo mode — uploads are read but not saved. Connect Supabase to build a persistent history.
          </p>
        )}

        {/* History list */}
        {!loading && records.length > 0 && (
          <section className="mt-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                {records.length} job{records.length !== 1 ? 's' : ''} in memory
              </h2>
              <span className="text-xs tabular-nums" style={{ color: 'var(--text-ghost)' }}>{aud(totalValue)} delivered</span>
            </div>
            <div className="grid gap-2.5">
              {records.map((r) => (
                <div key={r.id} className="rounded-xl px-4 py-3" style={{ background: 'var(--bg-surface)', border: `1px solid ${r.floor_area_m2 == null ? 'rgba(255,152,0,0.35)' : 'var(--bg-border)'}` }}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {titleize(r.job_type)}{r.region ? ` · ${r.region}` : ''}
                    </span>
                    <span className="text-sm font-semibold tabular-nums shrink-0" style={{ color: 'var(--text-primary)' }}>
                      {r.total_cost != null ? aud(r.total_cost) : '—'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-xs tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
                    {editId === r.id ? (
                      <span className="flex items-center gap-1.5">
                        <input
                          autoFocus type="number" inputMode="numeric" value={editVal} placeholder="m²"
                          onChange={(e) => setEditVal(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveArea(r.id); if (e.key === 'Escape') setEditId(null) }}
                          style={{ width: 72, background: 'var(--bg-elevated)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)', borderRadius: 6, padding: '2px 7px', fontSize: 12 }}
                        />
                        <button onClick={() => saveArea(r.id)} disabled={savingId === r.id} className="font-medium" style={{ color: 'var(--orange-primary)' }}>
                          {savingId === r.id ? 'Saving…' : 'Save'}
                        </button>
                        <button onClick={() => setEditId(null)} style={{ color: 'var(--text-tertiary)' }}>Cancel</button>
                      </span>
                    ) : r.floor_area_m2 != null ? (
                      <button onClick={() => { setEditId(r.id); setEditVal(String(r.floor_area_m2)) }} className="hover:underline" style={{ color: 'var(--text-tertiary)' }}>
                        {r.floor_area_m2.toLocaleString()} m²
                      </button>
                    ) : (
                      <button onClick={() => { setEditId(r.id); setEditVal('') }} className="font-medium hover:underline" style={{ color: 'var(--status-amber)' }}>
                        + Add floor area
                      </button>
                    )}
                    {r.cost_per_m2 != null && <span>{aud(r.cost_per_m2)}/m²</span>}
                    {r.finish_level && <span>{titleize(r.finish_level)}</span>}
                  </div>
                  {r.floor_area_m2 == null && editId !== r.id && (
                    <p className="text-xs mt-1" style={{ color: 'var(--status-amber)' }}>Add the floor area to use this job in estimates.</p>
                  )}
                  {r.project_summary && (
                    <p className="text-xs mt-1.5 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{r.project_summary}</p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {!loading && records.length === 0 && busy === 0 && (
          <p className="text-sm mt-4" style={{ color: 'var(--text-tertiary)' }}>No jobs in memory yet. Drop a few past quotes above to seed your estimates.</p>
        )}
      </main>
    </div>
  )
}
