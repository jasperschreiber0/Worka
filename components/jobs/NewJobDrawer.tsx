'use client'

import { useEffect, useRef, useState } from 'react'

interface NewJobDrawerProps {
  open: boolean
  onClose: () => void
  onCreated: (job: { id: string; address: string; status: string }) => void
}

interface CreateJobResponse {
  job: { id: string; address: string; status: string }
  is_duplicate: boolean
  existing_job?: { id: string; address: string; status: string }
  error?: string
}

// The reference workflow from the interaction spec — five structured fields,
// no round-trip through chat's intent classifier. Client + Address are the
// only two required to enable Continue; project name/builder/start date are
// optional (the AI can infer a project name from the drawings' title block
// once uploaded, so there's nothing lost by leaving it blank here).
export default function NewJobDrawer({ open, onClose, onCreated }: NewJobDrawerProps) {
  const [clientName, setClientName] = useState('')
  const [address, setAddress] = useState('')
  const [projectName, setProjectName] = useState('')
  const [startDate, setStartDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null)
  const [existingJob, setExistingJob] = useState<{ id: string; address: string; status: string } | null>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      // Cursor auto-focuses Client Name on open.
      const t = setTimeout(() => firstFieldRef.current?.focus(), 420)
      return () => clearTimeout(t)
    } else {
      setClientName('')
      setAddress('')
      setProjectName('')
      setStartDate('')
      setError(null)
      setDuplicateWarning(null)
      setExistingJob(null)
    }
  }, [open])

  async function handleSubmit(forceCreate = false) {
    if (!clientName.trim() || !address.trim()) return
    setSubmitting(true)
    setError(null)
    setDuplicateWarning(null)
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: address.trim(),
          client_name: clientName.trim(),
          scope_notes: projectName.trim() ? `Project: ${projectName.trim()}` : undefined,
          force_create: forceCreate,
        }),
      })
      const data: CreateJobResponse = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Couldn't create job — try again")
        setSubmitting(false)
        return
      }
      if (data.is_duplicate && !forceCreate) {
        setDuplicateWarning(`A job already exists at this address (${data.existing_job?.address ?? address}).`)
        setExistingJob(data.existing_job ?? null)
        setSubmitting(false)
        return
      }
      onCreated(data.job)
      setSubmitting(false)
    } catch {
      setError("Couldn't create job — try again")
      setSubmitting(false)
    }
  }

  return (
    <>
      {/* Backdrop */}
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
      {/* Drawer */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New job"
        className="fixed top-0 right-0 h-full z-50 flex flex-col w-full sm:w-[420px]"
        style={{
          background: 'var(--bg-surface)',
          borderLeft: '0.5px solid var(--bg-border)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: `transform ${open ? '400ms cubic-bezier(.2,.8,.2,1)' : '250ms cubic-bezier(.4,0,1,1)'}`,
        }}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '0.5px solid var(--bg-border)' }}>
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>New job</h2>
          <button onClick={onClose} className="btn-ghost w-8 h-8 flex items-center justify-center rounded-[6px]" aria-label="Close">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4">
          <div>
            <label className="label">Client name</label>
            <input ref={firstFieldRef} className="input w-full px-3 py-2" value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="e.g. The Hendersons" />
          </div>
          <div>
            <label className="label">Address</label>
            <input className="input w-full px-3 py-2" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="14 Merri St, Fitzroy VIC 3065" />
          </div>
          <div>
            <label className="label">Project name <span style={{ color: 'var(--text-tertiary)' }}>(optional)</span></label>
            <input className="input w-full px-3 py-2" value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="Kitchen &amp; bathroom renovation" />
          </div>
          <div>
            <label className="label">Start date <span style={{ color: 'var(--text-tertiary)' }}>(optional)</span></label>
            <input type="date" className="input w-full px-3 py-2" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>

          {duplicateWarning && (
            <div className="text-sm px-3 py-2.5 rounded-[6px]" style={{ background: 'var(--pill-awaiting-bg)', color: 'var(--pill-awaiting-text)', border: '1px solid var(--pill-awaiting-border)' }}>
              {duplicateWarning}
              <div className="flex gap-2 mt-2">
                <button className="btn-secondary text-xs px-2 py-1" onClick={() => handleSubmit(true)}>Create anyway</button>
                {existingJob && (
                  <button
                    className="btn-secondary text-xs px-2 py-1"
                    onClick={() => { onCreated(existingJob); }}
                  >
                    Open existing job
                  </button>
                )}
              </div>
            </div>
          )}
          {error && (
            <div className="text-sm px-3 py-2.5 rounded-[6px]" style={{ background: 'rgba(244,67,54,0.1)', color: 'var(--status-red)' }}>{error}</div>
          )}
        </div>

        <div className="px-5 py-4 flex gap-2" style={{ borderTop: '0.5px solid var(--bg-border)' }}>
          <button className="btn-secondary flex-1 py-2" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary flex-1 py-2"
            disabled={!clientName.trim() || !address.trim() || submitting}
            style={{ opacity: !clientName.trim() || !address.trim() ? 0.5 : 1 }}
            onClick={() => handleSubmit(false)}
          >
            {submitting ? 'Creating…' : 'Continue'}
          </button>
        </div>
      </div>
    </>
  )
}
