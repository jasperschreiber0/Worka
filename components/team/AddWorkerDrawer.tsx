'use client'

import { useEffect, useRef, useState } from 'react'
import type { WorkerListItem } from '@/app/api/workers/route'

interface AddWorkerDrawerProps {
  open: boolean
  onClose: () => void
  onCreated: (worker: WorkerListItem, inviteUrl: string) => void
}

const COMMON_TRADES = ['Carpenter', 'Plumber', 'Electrician', 'Tiler', 'Painter', 'Plasterer', 'Bricklayer', 'Concreter', 'Roofer', 'Labourer']

export default function AddWorkerDrawer({ open, onClose, onCreated }: AddWorkerDrawerProps) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [hourlyRate, setHourlyRate] = useState('')
  const [markup, setMarkup] = useState('')
  const [available, setAvailable] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => firstFieldRef.current?.focus(), 420)
      return () => clearTimeout(t)
    } else {
      setName(''); setRole(''); setPhone(''); setEmail(''); setHourlyRate(''); setMarkup(''); setAvailable(true); setError(null)
    }
  }, [open])

  async function handleSubmit() {
    if (!name.trim() || !role.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/workers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          role: role.trim(),
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
          hourly_rate: hourlyRate ? Number(hourlyRate) : undefined,
          default_markup_pct: markup ? Number(markup) / 100 : undefined,
          available,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to add worker')
        setSubmitting(false)
        return
      }
      onCreated(data.worker, data.invite_url)
      setSubmitting(false)
    } catch {
      setError('Failed to add worker')
      setSubmitting(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 transition-opacity"
        style={{ background: 'rgba(0,0,0,0.4)', opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none', transitionDuration: open ? '400ms' : '250ms' }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add worker"
        className="fixed top-0 right-0 h-full z-50 flex flex-col w-full sm:w-[420px]"
        style={{
          background: 'var(--bg-surface)',
          borderLeft: '0.5px solid var(--bg-border)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: `transform ${open ? '400ms cubic-bezier(.2,.8,.2,1)' : '250ms cubic-bezier(.4,0,1,1)'}`,
        }}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '0.5px solid var(--bg-border)' }}>
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Add worker</h2>
          <button onClick={onClose} className="btn-ghost w-8 h-8 flex items-center justify-center rounded-[6px]" aria-label="Close">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4">
          <div>
            <label className="label">Name</label>
            <input ref={firstFieldRef} className="input w-full px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jack Nguyen" />
          </div>
          <div>
            <label className="label">Trade</label>
            <input className="input w-full px-3 py-2" list="trade-options" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Carpenter" />
            <datalist id="trade-options">
              {COMMON_TRADES.map((t) => <option key={t} value={t} />)}
            </datalist>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Hourly rate <span style={{ color: 'var(--text-tertiary)' }}>(optional)</span></label>
              <input type="number" className="input w-full px-3 py-2" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} placeholder="65" />
            </div>
            <div>
              <label className="label">Default markup % <span style={{ color: 'var(--text-tertiary)' }}>(optional)</span></label>
              <input type="number" className="input w-full px-3 py-2" value={markup} onChange={(e) => setMarkup(e.target.value)} placeholder="15" />
            </div>
          </div>
          <div>
            <label className="label">Phone <span style={{ color: 'var(--text-tertiary)' }}>(optional)</span></label>
            <input className="input w-full px-3 py-2" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0400 000 000" />
          </div>
          <div>
            <label className="label">Email <span style={{ color: 'var(--text-tertiary)' }}>(optional)</span></label>
            <input type="email" className="input w-full px-3 py-2" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jack@example.com" />
          </div>
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={available} onChange={(e) => setAvailable(e.target.checked)} />
            Available for new jobs
          </label>

          {error && (
            <div className="text-sm px-3 py-2.5 rounded-[6px]" style={{ background: 'rgba(244,67,54,0.1)', color: 'var(--status-red)' }}>{error}</div>
          )}
        </div>

        <div className="px-5 py-4 flex gap-2" style={{ borderTop: '0.5px solid var(--bg-border)' }}>
          <button className="btn-secondary flex-1 py-2" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary flex-1 py-2"
            disabled={!name.trim() || !role.trim() || submitting}
            style={{ opacity: !name.trim() || !role.trim() ? 0.5 : 1 }}
            onClick={handleSubmit}
          >
            {submitting ? 'Adding…' : 'Add worker'}
          </button>
        </div>
      </div>
    </>
  )
}
