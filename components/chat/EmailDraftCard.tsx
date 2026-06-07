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

// ─── Orange-highlight body renderer ──────────────────────────────────────────

function highlightBody(text: string): React.ReactNode[] {
  // Highlight VAR-XXXX refs and dollar amounts like $12,450
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

// ─── Spinner ──────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg className="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  )
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
        style={{ border: '0.5px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)' }}
      >
        <div className="flex items-center gap-2.5 px-3 py-3">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: '#4caf50' }} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
            Email sent to <span style={{ color: 'var(--text-primary)' }}>{editedTo}</span> and logged.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      className="mt-2 rounded-[6px] overflow-hidden"
      style={{ border: '0.5px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)' }}
    >
      {/* ── Zone 1: Header ───────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: '0.5px solid var(--bg-border)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--text-tertiary)' }}>
            Draft
          </span>
          {draft.job_address && (
            <>
              <span style={{ color: 'var(--bg-border)' }}>·</span>
              <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{draft.job_address}</span>
            </>
          )}
        </div>
        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          To: {draft.to_name || editedTo}
        </span>
      </div>

      {/* ── Zone 2: Fields ───────────────────────────────────────────────── */}
      <div
        className="px-3 py-2 space-y-1"
        style={{ borderBottom: '0.5px solid var(--bg-border)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] w-[42px] flex-shrink-0 font-medium uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>From</span>
          <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>Worka &lt;noreply@getworka.com&gt;</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] w-[42px] flex-shrink-0 font-medium uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>Subject</span>
          <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{draft.subject}</span>
        </div>
      </div>

      {/* ── Zone 3: Body ─────────────────────────────────────────────────── */}
      <div className="px-3 py-3">
        {editingBody ? (
          <textarea
            className="w-full text-[12px] leading-relaxed resize-none rounded-[4px] px-2 py-1.5 focus:outline-none"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '0.5px solid var(--bg-border)',
              color: 'var(--text-primary)',
              minHeight: '140px',
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
            <p className="text-[12px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
              {highlightBody(editedBody)}
            </p>
          </button>
        )}
      </div>

      {/* ── Error ────────────────────────────────────────────────────────── */}
      {step === 'error' && error && (
        <div className="px-3 pb-2">
          <p className="text-[11px]" style={{ color: '#f44336' }}>{error}</p>
        </div>
      )}

      {/* ── Actions ──────────────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderTop: '0.5px solid var(--bg-border)' }}
      >
        <button
          type="button"
          onClick={onRevise}
          className="text-[12px] font-medium px-3 py-1.5 rounded-[4px] transition-colors"
          style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-elevated)' }}
        >
          Revise
        </button>
        <button
          type="button"
          onClick={handleSend}
          disabled={step === 'sending' || !editedTo.trim()}
          className="flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-[4px] transition-colors disabled:opacity-50"
          style={{ backgroundColor: 'var(--orange-primary)', color: '#ffffff' }}
        >
          {step === 'sending' ? <><Spinner /> Sending…</> : 'Send →'}
        </button>
      </div>
    </div>
  )
}
