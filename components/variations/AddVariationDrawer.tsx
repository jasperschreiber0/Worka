'use client'

import { useEffect, useRef, useState } from 'react'

interface CreatedVariation {
  id: string
  job_id: string
  title: string
  description: string
  amount: number
  status: string
  labour_cost?: number | null
  materials_cost?: number | null
}

interface AddVariationDrawerProps {
  open: boolean
  jobId: string
  onClose: () => void
  onCreated: (variation: CreatedVariation) => void
}

// Raising a variation is deliberately a draft, not an approval request — the
// builder decides afterwards (via the pending-actions list) whether to
// approve/reject it themselves or send it to the client for sign-off.
export default function AddVariationDrawer({ open, jobId, onClose, onCreated }: AddVariationDrawerProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [labourCost, setLabourCost] = useState('')
  const [materialsCost, setMaterialsCost] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => firstFieldRef.current?.focus(), 420)
      return () => clearTimeout(t)
    } else {
      setTitle('')
      setDescription('')
      setAmount('')
      setLabourCost('')
      setMaterialsCost('')
      setError(null)
    }
  }, [open])

  const amountValue = Number(amount)
  const canSubmit = title.trim().length > 0 && description.trim().length > 0 && amount.trim().length > 0 && !Number.isNaN(amountValue) && amountValue > 0

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/variations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: jobId,
          title: title.trim(),
          description: description.trim(),
          amount: amountValue,
          labour_cost: labourCost.trim() ? Number(labourCost) : undefined,
          materials_cost: materialsCost.trim() ? Number(materialsCost) : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Couldn't raise variation — try again")
        setSubmitting(false)
        return
      }
      onCreated(data.variation)
      setSubmitting(false)
    } catch {
      setError("Couldn't raise variation — try again")
      setSubmitting(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 transition-opacity"
        style={{
          background: 'rgba(0,0,0,0.4)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transitionDuration: open ? '400ms' : '250ms',
        }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Raise variation"
        className="fixed top-0 right-0 h-full z-50 flex flex-col w-full sm:w-[420px]"
        style={{
          background: 'var(--bg-surface)',
          borderLeft: '0.5px solid var(--bg-border)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: `transform ${open ? '400ms cubic-bezier(.2,.8,.2,1)' : '250ms cubic-bezier(.4,0,1,1)'}`,
        }}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '0.5px solid var(--bg-border)' }}>
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Raise variation</h2>
          <button onClick={onClose} className="btn-ghost w-8 h-8 flex items-center justify-center rounded-[6px]" aria-label="Close">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4">
          <div>
            <label className="label">Title</label>
            <input ref={firstFieldRef} className="input w-full px-3 py-2" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Upgrade to stone benchtops" />
          </div>
          <div>
            <label className="label">Description</label>
            <textarea className="input w-full px-3 py-2 min-h-[80px]" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What changed and why the client needs to approve it" />
          </div>
          <div>
            <label className="label">Amount (AUD, inc. GST)</label>
            <input type="number" min="0" className="input w-full px-3 py-2" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="3200" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Labour <span style={{ color: 'var(--text-tertiary)' }}>(optional)</span></label>
              <input type="number" min="0" className="input w-full px-3 py-2" value={labourCost} onChange={(e) => setLabourCost(e.target.value)} placeholder="1200" />
            </div>
            <div>
              <label className="label">Materials <span style={{ color: 'var(--text-tertiary)' }}>(optional)</span></label>
              <input type="number" min="0" className="input w-full px-3 py-2" value={materialsCost} onChange={(e) => setMaterialsCost(e.target.value)} placeholder="2000" />
            </div>
          </div>

          {error && (
            <div className="text-sm px-3 py-2.5 rounded-[6px]" style={{ background: 'rgba(244,67,54,0.1)', color: 'var(--status-red)' }}>{error}</div>
          )}
        </div>

        <div className="px-5 py-4 flex gap-2" style={{ borderTop: '0.5px solid var(--bg-border)' }}>
          <button className="btn-secondary flex-1 py-2" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary flex-1 py-2"
            disabled={!canSubmit || submitting}
            style={{ opacity: !canSubmit ? 0.5 : 1 }}
            onClick={handleSubmit}
          >
            {submitting ? 'Raising…' : 'Raise variation'}
          </button>
        </div>
      </div>
    </>
  )
}
