'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Props ────────────────────────────────────────────────────────────────────

export interface VariationNotificationModalProps {
  variationId: string
  builderId: string
  isOpen: boolean
  onClose: () => void
  onSent: () => void
}

// ─── API response types ───────────────────────────────────────────────────────

interface NotificationDraft {
  subject: string
  body: string
}

interface ResolveResponse {
  variation: {
    id: string
    job_address: string
    title: string
    amount: number
    status: string
  }
  notification_draft: NotificationDraft | null
  requires_builder_approval: boolean
}

interface SendNotificationResponse {
  sent: boolean
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
      className="animate-spin h-4 w-4 text-white"
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

export default function VariationNotificationModal({
  variationId,
  builderId,
  isOpen,
  onClose,
  onSent,
}: VariationNotificationModalProps) {
  type Step = 'loading' | 'draft' | 'confirm' | 'sending' | 'error'
  const [step, setStep] = useState<Step>('loading')

  // Draft fields (editable by builder)
  const [draftTo, setDraftTo] = useState('')
  const [draftSubject, setDraftSubject] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  const panelRef = useRef<HTMLDivElement>(null)

  // Load notification draft when opened
  useEffect(() => {
    if (!isOpen) return

    setStep('loading')
    setLoadError(null)
    setDraftTo('')
    setDraftSubject('')
    setDraftBody('')

    async function fetchDraft() {
      try {
        const res = await fetch(`/api/variations/${variationId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ builder_id: builderId, action: 'approved' }),
        })

        // If already approved (422), that's fine — fetch the existing draft from GET
        if (res.status === 422) {
          // Already approved — just fetch variation to get notification draft context
          const getRes = await fetch(`/api/variations/${variationId}`)
          if (!getRes.ok) {
            setLoadError('Failed to load variation details.')
            setStep('error')
            return
          }
          const getData = await getRes.json() as { variation: { job_address: string; title: string; amount: number } }
          const v = getData.variation
          setDraftTo('henderson@example.com')
          setDraftSubject(`Variation approved — ${v.job_address}`)
          setDraftBody(`Hi there,\n\nYour variation request has been approved.\n\n${v.title}\nAmount: $${v.amount.toLocaleString('en-AU')}\n\nThis amount will be added to your final invoice.\n\nDave Nguyen\nDave Nguyen Building`)
          setStep('draft')
          return
        }

        if (!res.ok) {
          const err = await res.json() as { error?: string }
          setLoadError(err.error ?? 'Failed to prepare notification draft.')
          setStep('error')
          return
        }

        const data = await res.json() as ResolveResponse

        if (!data.notification_draft) {
          // No draft (e.g. rejected) — just close
          onSent()
          return
        }

        // Use client email from demo data
        setDraftTo('henderson@example.com')
        setDraftSubject(data.notification_draft.subject)
        setDraftBody(data.notification_draft.body)
        setStep('draft')
      } catch {
        setLoadError('Something went wrong loading the notification draft.')
        setStep('error')
      }
    }

    fetchDraft()
  }, [isOpen, variationId, builderId, onSent])

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

  // Send notification
  const handleConfirmSend = useCallback(async () => {
    setStep('sending')
    try {
      const res = await fetch(`/api/variations/${variationId}/send-notification`, {
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
        setLoadError(err.error ?? 'Failed to send notification.')
        setStep('error')
        return
      }

      await res.json() as SendNotificationResponse
      onClose()
      onSent()
    } catch {
      setLoadError('Something went wrong sending the notification.')
      setStep('error')
    }
  }, [variationId, builderId, draftTo, draftSubject, draftBody, onClose, onSent])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(15, 23, 42, 0.7)' }}
      aria-modal="true"
      role="dialog"
      aria-label="Notify client about approved variation"
    >
      <div
        ref={panelRef}
        className="w-full max-w-lg bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ maxHeight: 'calc(100vh - 2rem)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 flex-shrink-0">
          <div className="flex items-center gap-3">
            {(step === 'confirm' || step === 'sending') && (
              <button
                type="button"
                onClick={() => setStep('draft')}
                disabled={step === 'sending'}
                className="w-7 h-7 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Back to draft"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
                </svg>
              </button>
            )}
            <h2 className="text-sm font-semibold text-slate-900">
              {step === 'loading' && 'Preparing draft…'}
              {step === 'draft' && 'Notify client?'}
              {(step === 'confirm' || step === 'sending') && 'Confirm send'}
              {step === 'error' && 'Something went wrong'}
            </h2>
          </div>
          <div className="flex items-center gap-3">
            {(step === 'draft' || step === 'confirm') && (
              <span className="text-xs font-medium text-slate-400">
                Step {step === 'draft' ? '1' : '2'} of 2
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
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

          {/* Loading */}
          {step === 'loading' && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <svg className="animate-spin h-8 w-8 text-brand-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <p className="text-sm text-slate-500">Preparing notification draft…</p>
            </div>
          )}

          {/* Error */}
          {step === 'error' && (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-3">
              <svg className="w-10 h-10 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <p className="text-sm text-red-600 font-medium">{loadError}</p>
              <button
                type="button"
                onClick={onClose}
                className="mt-2 px-4 py-2 text-sm font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
              >
                Close
              </button>
            </div>
          )}

          {/* Step 1 — Draft review */}
          {step === 'draft' && (
            <div className="px-5 py-5 space-y-4">
              <p className="text-sm text-slate-600 leading-relaxed">
                The variation has been approved. Do you want to notify the client?
              </p>

              {/* To */}
              <div>
                <label htmlFor="notif-to" className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                  To
                </label>
                <input
                  id="notif-to"
                  type="email"
                  value={draftTo}
                  onChange={(e) => setDraftTo(e.target.value)}
                  placeholder="client@example.com"
                  className="w-full px-3 py-2 text-sm text-slate-900 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent"
                />
              </div>

              {/* Subject */}
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                  Subject
                </label>
                <p className="px-3 py-2 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg select-text">
                  {draftSubject}
                </p>
              </div>

              {/* Body */}
              <div>
                <label htmlFor="notif-body" className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                  Message
                </label>
                <textarea
                  id="notif-body"
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                  rows={10}
                  className="w-full px-3 py-2 text-sm text-slate-900 font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent resize-y leading-relaxed"
                />
              </div>
            </div>
          )}

          {/* Step 2 — Confirm */}
          {(step === 'confirm' || step === 'sending') && (
            <div className="px-5 py-6 space-y-5">
              {/* Sending to */}
              <div className="flex items-center gap-2.5 p-3 bg-green-50 border border-green-200 rounded-lg">
                <svg className="w-5 h-5 text-green-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-green-700 uppercase tracking-wide">Sending to</p>
                  <p className="text-sm font-medium text-green-900 truncate">{draftTo}</p>
                </div>
              </div>

              {/* Explanation */}
              <div className="space-y-3 text-sm text-slate-600 leading-relaxed">
                <p>
                  This will notify the client that their variation has been approved. WorkA will log this to the job&apos;s communication history.
                </p>
              </div>

              {/* Subject preview */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Subject</p>
                <p className="text-sm text-slate-700">{draftSubject}</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer / Actions */}
        {step === 'draft' && (
          <div className="flex items-center justify-between px-5 py-4 border-t border-slate-200 flex-shrink-0 bg-white">
            <button
              type="button"
              onClick={() => { onClose(); onSent() }}
              className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
            >
              Skip — don&apos;t notify
            </button>
            <button
              type="button"
              onClick={() => setStep('confirm')}
              disabled={!draftTo.trim()}
              className="flex items-center gap-2 px-5 py-2 text-sm font-semibold bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Looks good
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </button>
          </div>
        )}

        {(step === 'confirm' || step === 'sending') && (
          <div className="flex items-center justify-between px-5 py-4 border-t border-slate-200 flex-shrink-0 bg-white">
            <button
              type="button"
              onClick={() => setStep('draft')}
              disabled={step === 'sending'}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
              className="flex items-center gap-2 px-5 py-2 text-sm font-semibold bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {step === 'sending' ? (
                <>
                  <Spinner />
                  Sending…
                </>
              ) : (
                <>
                  Send notification
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
