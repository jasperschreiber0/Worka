'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Props ────────────────────────────────────────────────────────────────────

export type EmailIntentHint = 'invoice' | 'quote_followup' | 'variation' | 'general'

export interface EmailDraftModalProps {
  isOpen: boolean
  onClose: () => void
  onSent: (commId: string, recipientName: string, jobAddress: string | null) => void
  builderId: string
  jobId?: string | null
  recipientName?: string
  intentHint?: EmailIntentHint
  contextMessage?: string
}

// ─── API response types ───────────────────────────────────────────────────────

interface EmailDraft {
  to: string
  to_name: string
  subject: string
  body: string
  job_id: string | null
  job_address: string | null
}

interface EmailDraftResponse {
  draft: EmailDraft
  context_used: {
    job_address: string | null
    client_name: string | null
    intent_hint: EmailIntentHint
  }
  requires_confirmation: true
}

interface SendEmailResponse {
  sent: boolean
  communication_id: string
  sent_at: string
}

// ─── Focusable selector ───────────────────────────────────────────────────────

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// ─── Spinner ──────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4"
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

export default function EmailDraftModal({
  isOpen,
  onClose,
  onSent,
  builderId,
  jobId,
  recipientName,
  intentHint = 'general',
  contextMessage,
}: EmailDraftModalProps) {
  type Step = 'loading' | 'draft' | 'confirm' | 'sending' | 'error'
  const [step, setStep] = useState<Step>('loading')

  const [draftTo, setDraftTo] = useState('')
  const [draftSubject, setDraftSubject] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [jobAddress, setJobAddress] = useState<string | null>(null)
  const [resolvedJobId, setResolvedJobId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const panelRef = useRef<HTMLDivElement>(null)

  // Load draft when opened
  useEffect(() => {
    if (!isOpen) return

    setStep('loading')
    setLoadError(null)
    setDraftTo('')
    setDraftSubject('')
    setDraftBody('')
    setJobAddress(null)
    setResolvedJobId(null)

    async function fetchDraft() {
      try {
        const res = await fetch('/api/email-draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            builder_id: builderId,
            job_id: jobId ?? null,
            recipient_name: recipientName,
            intent_hint: intentHint,
            context: contextMessage,
          }),
        })

        if (!res.ok) {
          const err = await res.json() as { error?: string }
          setLoadError(err.error ?? 'Failed to generate email draft.')
          setStep('error')
          return
        }

        const data = await res.json() as EmailDraftResponse
        setDraftTo(data.draft.to)
        setDraftSubject(data.draft.subject)
        setDraftBody(data.draft.body)
        setJobAddress(data.draft.job_address)
        setResolvedJobId(data.draft.job_id)
        setStep('draft')
      } catch {
        setLoadError('Something went wrong generating the draft.')
        setStep('error')
      }
    }

    fetchDraft()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, builderId, jobId, recipientName, intentHint, contextMessage])

  // Focus first focusable element when step changes
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

  // Escape key + focus trap
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

  // Send the email
  const handleConfirmSend = useCallback(async () => {
    setStep('sending')
    try {
      const res = await fetch('/api/email-draft/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builder_id: builderId,
          job_id: resolvedJobId ?? null,
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

      const data = await res.json() as SendEmailResponse
      onClose()
      onSent(data.communication_id, draftTo, jobAddress)
    } catch {
      setLoadError('Something went wrong sending the email.')
      setStep('error')
    }
  }, [builderId, resolvedJobId, draftTo, draftSubject, draftBody, jobAddress, onClose, onSent])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(15, 23, 42, 0.7)' }}
      aria-modal="true"
      role="dialog"
      aria-label="Draft email to client"
    >
      <div
        ref={panelRef}
        className="w-full max-w-lg rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ maxHeight: 'calc(100vh - 2rem)', background: 'var(--bg-surface)' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--bg-border)' }}
        >
          <div className="flex items-center gap-3">
            {(step === 'confirm' || step === 'sending') && (
              <button
                type="button"
                onClick={() => setStep('draft')}
                disabled={step === 'sending'}
                className="w-7 h-7 flex items-center justify-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ color: 'var(--text-tertiary)' }}
                aria-label="Back to draft"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
                </svg>
              </button>
            )}
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {step === 'loading' && 'Drafting email…'}
              {step === 'draft' && 'Draft email'}
              {(step === 'confirm' || step === 'sending') && 'Confirm send'}
              {step === 'error' && 'Something went wrong'}
            </h2>
          </div>
          <div className="flex items-center gap-3">
            {(step === 'draft' || step === 'confirm') && (
              <span className="text-xs font-medium" style={{ color: 'var(--text-tertiary)' }}>
                Step {step === 'draft' ? '1' : '2'} of 2
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-full transition-colors"
              style={{ color: 'var(--text-tertiary)' }}
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">

          {/* Loading — skeleton */}
          {step === 'loading' && (
            <div className="px-5 py-5 space-y-4">
              {/* To skeleton */}
              <div>
                <div className="h-3 w-6 rounded animate-pulse mb-1.5" style={{ background: 'var(--bg-elevated)' }} />
                <div className="h-9 w-full rounded-lg animate-pulse" style={{ background: 'var(--bg-elevated)' }} />
              </div>
              {/* Subject skeleton */}
              <div>
                <div className="h-3 w-14 rounded animate-pulse mb-1.5" style={{ background: 'var(--bg-elevated)' }} />
                <div className="h-9 w-full rounded-lg animate-pulse" style={{ background: 'var(--bg-elevated)' }} />
              </div>
              {/* Body skeleton */}
              <div>
                <div className="h-3 w-16 rounded animate-pulse mb-1.5" style={{ background: 'var(--bg-elevated)' }} />
                <div className="h-48 w-full rounded-lg animate-pulse" style={{ background: 'var(--bg-elevated)' }} />
              </div>
            </div>
          )}

          {/* Error */}
          {step === 'error' && (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-3">
              <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true" style={{ color: 'var(--status-red)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <p className="text-sm font-medium" style={{ color: 'var(--status-red)' }}>{loadError}</p>
              <button
                type="button"
                onClick={onClose}
                className="mt-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors"
                style={{ color: 'var(--text-secondary)', border: '1px solid var(--bg-border)' }}
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
                <label htmlFor="email-draft-to" className="block text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  To
                </label>
                <input
                  id="email-draft-to"
                  type="email"
                  value={draftTo}
                  onChange={(e) => setDraftTo(e.target.value)}
                  placeholder="client@example.com"
                  className="w-full px-3 py-2 text-sm rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent"
                  style={{ color: 'var(--text-primary)', background: 'var(--bg-shell)', border: '1px solid var(--bg-border)' }}
                />
              </div>

              {/* Subject — display only */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Subject
                </label>
                <p
                  className="px-3 py-2 text-sm rounded-lg select-text"
                  style={{ color: 'var(--text-secondary)', background: 'var(--bg-elevated)', border: '1px solid var(--bg-border)' }}
                >
                  {draftSubject}
                </p>
              </div>

              {/* Body — editable */}
              <div>
                <label htmlFor="email-draft-body" className="block text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Message
                </label>
                <textarea
                  id="email-draft-body"
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                  rows={12}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent resize-y leading-relaxed"
                  style={{ color: 'var(--text-primary)', background: 'var(--bg-shell)', border: '1px solid var(--bg-border)' }}
                />
              </div>
            </div>
          )}

          {/* Step 2 — Confirm */}
          {(step === 'confirm' || step === 'sending') && (
            <div className="px-5 py-6 space-y-5">
              {/* Sending to */}
              <div className="flex items-center gap-2.5 p-3 rounded-lg" style={{ background: 'rgba(76,175,80,0.15)', border: '1px solid rgba(76,175,80,0.25)' }}>
                <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true" style={{ color: 'var(--status-green)' }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--status-green)' }}>Sending to</p>
                  <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{draftTo}</p>
                </div>
              </div>

              {/* Irreversibility warning */}
              <div className="flex items-start gap-2.5 p-3 rounded-lg" style={{ background: 'rgba(255,152,0,0.1)', border: '1px solid rgba(255,152,0,0.25)' }}>
                <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true" style={{ color: 'var(--status-amber)' }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
                <div>
                  <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--status-amber)' }}>This will send immediately</p>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--status-amber)' }}>
                    The email will be sent to <span className="font-semibold">{draftTo}</span> and logged to communication history. This cannot be undone.
                  </p>
                </div>
              </div>

              {/* Subject preview */}
              <div className="p-3 rounded-lg" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--bg-border)' }}>
                <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--text-tertiary)' }}>Subject</p>
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{draftSubject}</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer / Actions */}
        {step === 'draft' && (
          <div
            className="flex items-center justify-between px-5 py-4 flex-shrink-0"
            style={{ borderTop: '1px solid var(--bg-border)', background: 'var(--bg-surface)' }}
          >
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-lg transition-colors"
              style={{ color: 'var(--text-secondary)', border: '1px solid var(--bg-border)' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => setStep('confirm')}
              disabled={!draftTo.trim()}
              className="flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed btn-primary"
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
            style={{ borderTop: '1px solid var(--bg-border)', background: 'var(--bg-surface)' }}
          >
            <button
              type="button"
              onClick={() => setStep('draft')}
              disabled={step === 'sending'}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: 'var(--text-secondary)', border: '1px solid var(--bg-border)' }}
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
              className="flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed btn-primary"
            >
              {step === 'sending' ? (
                <>
                  <Spinner />
                  Sending…
                </>
              ) : (
                <>
                  Confirm &amp; send →
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
