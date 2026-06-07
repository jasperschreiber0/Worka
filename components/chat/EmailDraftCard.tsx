'use client'

import { useState, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EmailDraftData {
  to: string
  to_name: string
  subject: string
  body: string
  job_id: string | null
  job_address: string | null
}

interface EmailDraftCardProps {
  draft: EmailDraftData
  builderId: string
  onSent?: (commId: string, recipientName: string, jobAddress: string | null) => void
  onRevise?: () => void
}

// ─── Highlight VAR refs and $ amounts in body ─────────────────────────────────

function highlightBody(text: string): React.ReactNode[] {
  const regex = /(VAR-\d+|\$[\d,]+(?:\.\d{1,2})?)/g
  const parts: React.ReactNode[] = []
  let last = 0
  let match
  let key = 0
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    parts.push(
      <span key={key++} style={{ color: 'var(--orange-primary)' }}>
        {match[1]}
      </span>
    )
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function EmailDraftCard({ draft, builderId, onSent, onRevise }: EmailDraftCardProps) {
  const [step, setStep] = useState<'draft' | 'sending' | 'sent' | 'error'>('draft')
  const [editedBody, setEditedBody] = useState(draft.body)
  const [editedTo, setEditedTo] = useState(draft.to)
  const [editingBody, setEditingBody] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSend = useCallback(async () => {
    setStep('sending')
    setError(null)
    try {
      const res = await fetch('/api/email-draft/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builder_id: builderId,
          job_id: draft.job_id,
          to: editedTo,
          subject: draft.subject,
          body: editedBody,
        }),
      })
      if (!res.ok) {
        const err = await res.json() as { error?: string }
        setError(err.error ?? 'Failed to send.')
        setStep('error')
        return
      }
      const data = await res.json() as { communication_id: string }
      setStep('sent')
      onSent?.(data.communication_id, editedTo, draft.job_address)
    } catch {
      setError('Something went wrong.')
      setStep('error')
    }
  }, [builderId, draft, editedTo, editedBody, onSent])

  if (step === 'sent') {
    return (
      <div
        className="mt-2 rounded-[6px] overflow-hidden"
        style={{ border: '0.5px solid var(--bg-border)', backgroundColor: 'var(--bg-elevated)' }}
      >
        <div className="flex items-center gap-2.5 px-4 py-3">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: 'var(--status-green)' }} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            Sent to <span style={{ color: 'var(--text-primary)' }}>{editedTo}</span> and logged.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      className="mt-2 rounded-[6px] overflow-hidden"
      style={{ border: '0.5px solid var(--bg-border)', backgroundColor: 'var(--bg-elevated)' }}
    >
      {/* ── Zone 1: Header bar ───────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: '0.5px solid var(--bg-border)' }}
      >
        <span
          className="text-[10px] font-medium uppercase tracking-[0.08em]"
          style={{ color: 'var(--text-tertiary)' }}
        >
          DRAFT EMAIL
        </span>
        <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          To: {draft.to_name || editedTo}
        </span>
      </div>

      {/* ── Zone 2: Fields (From / Subject) ─────────────────────────────── */}
      <div
        className="px-4 py-2.5 space-y-1"
        style={{ borderBottom: '0.5px solid var(--bg-border)' }}
      >
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] w-[40px] flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>From</span>
          <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>WorkA &lt;noreply@getworka.com&gt;</span>
        </div>
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] w-[40px] flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>Subj.</span>
          <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{draft.subject}</span>
        </div>
      </div>

      {/* ── Zone 3: Body ────────────────────────────────────────────────── */}
      <div className="px-4 py-3">
        {editingBody ? (
          <textarea
            className="w-full text-[13px] leading-relaxed resize-none focus:outline-none rounded-[4px] p-0"
            style={{
              backgroundColor: 'transparent',
              border: 'none',
              color: 'var(--text-primary)',
              minHeight: '120px',
            }}
            value={editedBody}
            onChange={(e) => setEditedBody(e.target.value)}
            onBlur={() => setEditingBody(false)}
            autoFocus
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingBody(true)}
            className="w-full text-left cursor-text"
            aria-label="Edit email body"
          >
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-primary)', lineHeight: '1.6' }}>
              {highlightBody(editedBody)}
            </p>
          </button>
        )}
      </div>

      {/* ── Error ────────────────────────────────────────────────────────── */}
      {step === 'error' && error && (
        <div className="px-4 pb-2">
          <p className="text-[11px]" style={{ color: 'var(--status-red)' }}>{error}</p>
        </div>
      )}

      {/* ── Revise / Send bar ────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-4 py-2.5 rounded-[4px] mx-2 mb-2"
        style={{ backgroundColor: 'rgba(255,255,255,0.04)', border: '0.5px solid var(--bg-border)' }}
      >
        <button
          type="button"
          onClick={onRevise}
          className="text-[13px]"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Revise ↑
        </button>
        <button
          type="button"
          onClick={handleSend}
          disabled={step === 'sending' || !editedTo.trim()}
          className="text-[13px] font-semibold disabled:opacity-50"
          style={{ color: 'var(--orange-primary)' }}
        >
          {step === 'sending' ? 'Sending…' : 'Send to client →'}
        </button>
      </div>
    </div>
  )
}
