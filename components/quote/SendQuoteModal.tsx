'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Props ────────────────────────────────────────────────────────────────────

export interface SendQuoteModalProps {
  quoteId: string
  builderId: string
  isOpen: boolean
  onClose: () => void
  onSent: (sentAt: string) => void
}

// ─── API response types ───────────────────────────────────────────────────────

interface QuoteSummaryForDraft {
  total_cost: number
  margin_pct: number
  line_count: number
  address: string
}

interface EmailDraft {
  to: string
  subject: string
  body: string
  quote_summary: QuoteSummaryForDraft
}

interface SendApiResponse {
  draft: EmailDraft
  requires_confirmation: true
}

interface ConfirmSendApiResponse {
  sent: true
  sent_at: string
  communication_id: string
}

// ─── Focusable selector ───────────────────────────────────────────────────────

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// ─── Spinner ──────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4"
      style={{ color: 'var(--text-primary)' }}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SendQuoteModal({
  quoteId,
  builderId,
  isOpen,
  onClose,
  onSent,
}: SendQuoteModalProps) {
  // ── Step state ──────────────────────────────────────────────────────────────
  type Step = 'loading' | 'draft' | 'confirm' | 'sending' | 'error'
  const [step, setStep] = useState<Step>('loading')

  // ── Draft fields (editable by builder) ─────────────────────────────────────
  const [draftTo, setDraftTo] = useState('')
  const [draftSubject, setDraftSubject] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  const panelRef = useRef<HTMLDivElement>(null)
  const firstFocusRef = useRef<HTMLButtonElement | null>(null)

  // ── Load draft on open ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return

    // Reset state when opening
    setStep('loading')
    setLoadError(null)
    setDraftTo('')
    setDraftSubject('')
    setDraftBody('')

    async function fetchDraft() {
      try {
        const res = await fetch(`/api/quotes/${quoteId}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ builder_id: builderId }),
        })

        if (!res.ok) {
          const err = await res.json() as { error?: string }
          setLoadError(err.error ?? 'Failed to prepare email draft.')
          setStep('error')
          return
        }

        const data = await res.json() as SendApiResponse
        setDraftTo(data.draft.to)
        setDraftSubject(data.draft.subject)
        setDraftBody(data.draft.body)
        setStep('draft')
      } catch {
        setLoadError('Something went wrong loading the email draft.')
        setStep('error')
      }
    }

    fetchDraft()
  }, [isOpen, quoteId, builderId])

  // ── Focus first element when step changes ───────────────────────────────────
  useEffect(() => {
    if (!isOpen) return
    const id = setTimeout(() => {
      if (panelRef.current) {
        const focusable = panelRef.current.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
        focusable?.focus()
      }
    }, 50)
    return () => clearTimeout(id)
  }, [step, isOpen])

  // ── Escape key + focus trap ─────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return

      if (e.key === 'Escape') {
        if (step === 'confirm') {
          setStep('draft')
        } else {
          onClose()
        }
        return
      }

      if (e.key === 'Tab' && panelRef.current) {
        const focusable = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    },
    [isOpen, step, onClose]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // ── Send confirmation ───────────────────────────────────────────────────────
  const handleConfirmSend = useCallback(async () => {
    setStep('sending')
    try {
      const res = await fetch(`/api/quotes/${quoteId}/confirm-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builder_id: builderId,
          to: draftTo,
          subject: draftSubject,
          body: draftBody,
        }),
      })

      if (!res.ok) {
        const err = await res.json() as { error?: string }
        setLoadError(err.error ?? 'Failed to send email.')
        setStep('error')
        return
      }

      const data = await res.json() as ConfirmSendApiResponse
      onClose()
      onSent(data.sent_at)
    } catch {
      setLoadError('Something went wrong sending the email.')
      setStep('error')
    }
  }, [quoteId, builderId, draftTo, draftSubject, draftBody, onClose, onSent])

  if (!isOpen) return null

  return (
    // Backdrop — not clickable to close (builder must explicitly act)
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(15, 23, 42, 0.7)' }}
      aria-modal="true"
      role="dialog"
      aria-label="Send quote to client"
    >
      <div
        ref={panelRef}
        className="w-full max-w-lg rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ backgroundColor: 'var(--bg-surface)', maxHeight: 'calc(100vh - 2rem)' }}
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div
          className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--bg-border)' }}
        >
          <div className="flex items-center gap-3">
            {(step === 'confirm' || step === 'sending') && (
              <button
                ref={firstFocusRef}
                type="button"
                onClick={() => setStep('draft')}
                disabled={step === 'sending'}
                className="w-7 h-7 flex items-center justify-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ color: 'var(--text-tertiary)' }}
                onMouseEnter={e => {
                  e.currentTarget.style.color = 'var(--text-primary)'
                  e.currentTarget.style.backgroundColor = 'var(--bg-elevated)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.color = 'var(--text-tertiary)'
                  e.currentTarget.style.backgroundColor = ''
                }}
                aria-label="Back to draft"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
                </svg>
              </button>
            )}
            <h2 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {step === 'loading' && 'Preparing draft…'}
              {step === 'draft' && 'Review before sending'}
              {step === 'confirm' || step === 'sending' ? 'Confirm send' : null}
              {step === 'error' && 'Something went wrong'}
            </h2>
          </div>
          <div className="flex items-center gap-3">
            {(step === 'draft' || step === 'confirm') && (
              <span className="text-[11px] font-medium" style={{ color: 'var(--text-tertiary)' }}>
                Step {step === 'draft' ? '1' : '2'} of 2
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-full transition-colors"
              style={{ color: 'var(--text-tertiary)' }}
              onMouseEnter={e => {
                e.currentTarget.style.color = 'var(--text-primary)'
                e.currentTarget.style.backgroundColor = 'var(--bg-elevated)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.color = 'var(--text-tertiary)'
                e.currentTarget.style.backgroundColor = ''
              }}
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* ── Body ───────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">

          {/* Loading */}
          {step === 'loading' && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <svg className="animate-spin h-8 w-8" style={{ color: 'var(--orange-primary)' }} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>Preparing email draft…</p>
            </div>
          )}

          {/* Error */}
          {step === 'error' && (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-3">
              <svg className="w-10 h-10" style={{ color: 'var(--status-red)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <p className="text-[13px] font-medium" style={{ color: 'var(--status-red)' }}>{loadError}</p>
              <button
                type="button"
                onClick={onClose}
                className="mt-2 px-4 py-2 text-[13px] font-medium rounded-lg transition-colors"
                style={{ color: 'var(--text-secondary)', border: '1px solid var(--bg-border)' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--bg-elevated)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
              >
                Close
              </button>
            </div>
          )}

          {/* Step 1 — Draft review */}
          {step === 'draft' && (
            <div className="px-5 py-5 space-y-4">
              {/* To */}
              <div>
                <label htmlFor="send-to" className="block text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
                  To
                </label>
                <input
                  id="send-to"
                  type="email"
                  value={draftTo}
                  onChange={(e) => setDraftTo(e.target.value)}
                  placeholder="client@example.com"
                  className="w-full px-3 py-2 text-[13px] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--orange-primary)] focus:border-transparent"
                  style={{
                    color: 'var(--text-primary)',
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--bg-border)',
                  }}
                />
              </div>

              {/* Subject */}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
                  Subject
                </label>
                <p
                  className="px-3 py-2 text-[13px] rounded-lg select-text"
                  style={{
                    color: 'var(--text-secondary)',
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--bg-border)',
                  }}
                >
                  {draftSubject}
                </p>
              </div>

              {/* Body */}
              <div>
                <label htmlFor="send-body" className="block text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
                  Message
                </label>
                <textarea
                  id="send-body"
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                  rows={12}
                  className="w-full px-3 py-2 text-[13px] font-mono rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--orange-primary)] focus:border-transparent resize-y leading-relaxed"
                  style={{
                    color: 'var(--text-primary)',
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--bg-border)',
                  }}
                />
              </div>
            </div>
          )}

          {/* Step 2 — Confirm */}
          {(step === 'confirm' || step === 'sending') && (
            <div className="px-5 py-6 space-y-5">
              {/* Sending to */}
              <div
                className="flex items-center gap-2.5 p-3 rounded-lg"
                style={{ backgroundColor: 'rgba(76,175,80,0.1)', border: '1px solid rgba(76,175,80,0.25)' }}
              >
                <svg className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--status-green)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--status-green)' }}>Sending to</p>
                  <p className="text-[13px] font-medium truncate" style={{ color: 'var(--status-green)' }}>{draftTo}</p>
                </div>
              </div>

              {/* Explanation */}
              <div className="space-y-3 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                <p>
                  This will send the quote from your WorkA account. The client will receive it immediately.
                </p>
                <p>
                  WorkA will log this email to the job&apos;s communication history so you always have a record.
                </p>
              </div>

              {/* Subject preview */}
              <div
                className="p-3 rounded-lg"
                style={{ backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--bg-border)' }}
              >
                <p className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--text-tertiary)' }}>Subject</p>
                <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>{draftSubject}</p>
              </div>
            </div>
          )}
        </div>

        {/* ── Footer / Actions ────────────────────────────────────────── */}
        {step === 'draft' && (
          <div
            className="flex items-center justify-between px-5 py-4 flex-shrink-0"
            style={{ borderTop: '1px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)' }}
          >
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-[13px] font-medium rounded-lg transition-colors"
              style={{ color: 'var(--text-secondary)', border: '1px solid var(--bg-border)' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--bg-elevated)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => setStep('confirm')}
              disabled={!draftTo.trim()}
              className="flex items-center gap-2 px-5 py-2 text-[13px] font-semibold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: 'var(--orange-primary)', color: '#fff' }}
              onMouseEnter={e => { if (draftTo.trim()) e.currentTarget.style.opacity = '0.9' }}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              Looks good
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </button>
          </div>
        )}

        {(step === 'confirm' || step === 'sending') && (
          <div
            className="flex items-center justify-between px-5 py-4 flex-shrink-0"
            style={{ borderTop: '1px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)' }}
          >
            <button
              type="button"
              onClick={() => setStep('draft')}
              disabled={step === 'sending'}
              className="flex items-center gap-2 px-4 py-2 text-[13px] font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: 'var(--text-secondary)', border: '1px solid var(--bg-border)' }}
              onMouseEnter={e => { if (step !== 'sending') e.currentTarget.style.backgroundColor = 'var(--bg-elevated)' }}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
              </svg>
              Back
            </button>
            <button
              type="button"
              onClick={handleConfirmSend}
              disabled={step === 'sending'}
              className="flex items-center gap-2 px-5 py-2 text-[13px] font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: 'var(--orange-primary)', color: '#fff' }}
              onMouseEnter={e => { if (step !== 'sending') e.currentTarget.style.opacity = '0.9' }}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              {step === 'sending' ? (
                <>
                  <Spinner />
                  Sending…
                </>
              ) : (
                <>
                  Send quote
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                  </svg>
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
