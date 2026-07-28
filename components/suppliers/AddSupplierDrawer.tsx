'use client'

import { useEffect, useRef, useState } from 'react'
import { TRADE_CATEGORIES } from '@/lib/trade-taxonomy'
import type { Supplier } from '@/lib/types/database.types'

interface AddSupplierDrawerProps {
  open: boolean
  onClose: () => void
  onCreated: (supplier: Supplier) => void
}

export default function AddSupplierDrawer({ open, onClose, onCreated }: AddSupplierDrawerProps) {
  const [name, setName] = useState('')
  const [tradeId, setTradeId] = useState<string>('')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => firstFieldRef.current?.focus(), 420)
      return () => clearTimeout(t)
    } else {
      setName(''); setTradeId(''); setContactName(''); setContactPhone(''); setContactEmail(''); setNotes(''); setError(null)
    }
  }, [open])

  async function handleSubmit() {
    if (!name.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          preferred_trade_category_id: tradeId ? Number(tradeId) : null,
          contact_name: contactName.trim() || undefined,
          contact_phone: contactPhone.trim() || undefined,
          contact_email: contactEmail.trim() || undefined,
          pricing_agreement_notes: notes.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to add supplier')
        setSubmitting(false)
        return
      }
      onCreated(data.supplier)
      setSubmitting(false)
    } catch {
      setError('Failed to add supplier')
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
        aria-label="Add supplier"
        className="fixed top-0 right-0 h-full z-50 flex flex-col w-full sm:w-[420px]"
        style={{
          background: 'var(--bg-surface)',
          borderLeft: '0.5px solid var(--bg-border)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: `transform ${open ? '400ms cubic-bezier(.2,.8,.2,1)' : '250ms cubic-bezier(.4,0,1,1)'}`,
        }}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '0.5px solid var(--bg-border)' }}>
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Add supplier</h2>
          <button onClick={onClose} className="btn-ghost w-8 h-8 flex items-center justify-center rounded-[6px]" aria-label="Close">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4">
          <div>
            <label className="label">Supplier name</label>
            <input ref={firstFieldRef} className="input w-full px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} placeholder="Reece Plumbing" />
          </div>
          <div>
            <label className="label">Preferred trade <span style={{ color: 'var(--text-tertiary)' }}>(optional)</span></label>
            <select className="input w-full px-3 py-2" value={tradeId} onChange={(e) => setTradeId(e.target.value)}>
              <option value="">—</option>
              {TRADE_CATEGORIES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Contact name <span style={{ color: 'var(--text-tertiary)' }}>(optional)</span></label>
            <input className="input w-full px-3 py-2" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Dave" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Phone <span style={{ color: 'var(--text-tertiary)' }}>(optional)</span></label>
              <input className="input w-full px-3 py-2" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="0400 000 000" />
            </div>
            <div>
              <label className="label">Email <span style={{ color: 'var(--text-tertiary)' }}>(optional)</span></label>
              <input type="email" className="input w-full px-3 py-2" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="dave@reece.com.au" />
            </div>
          </div>
          <div>
            <label className="label">Pricing agreement notes <span style={{ color: 'var(--text-tertiary)' }}>(optional)</span></label>
            <textarea className="input w-full px-3 py-2" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Trade account — 15% off list" />
          </div>

          {error && (
            <div className="text-sm px-3 py-2.5 rounded-[6px]" style={{ background: 'rgba(244,67,54,0.1)', color: 'var(--status-red)' }}>{error}</div>
          )}
        </div>

        <div className="px-5 py-4 flex gap-2" style={{ borderTop: '0.5px solid var(--bg-border)' }}>
          <button className="btn-secondary flex-1 py-2" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary flex-1 py-2"
            disabled={!name.trim() || submitting}
            style={{ opacity: !name.trim() ? 0.5 : 1 }}
            onClick={handleSubmit}
          >
            {submitting ? 'Adding…' : 'Add supplier'}
          </button>
        </div>
      </div>
    </>
  )
}
