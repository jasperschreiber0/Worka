'use client'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InboundEmailAlertProps {
  email: {
    from: string
    subject: string
    preview: string           // first 80 chars of body
    received_display: string  // "just now", "2 hours ago"
  }
  job_address: string
  intent: string              // human-readable: "Quote acceptance", "Invoice query", etc.
  suggested_action: {
    type: string
    description: string
    draft?: { subject: string; body: string }
  } | null
  onReply: () => void    // opens EmailDraftModal with the draft pre-filled
  onDismiss: () => void  // dismisses the alert
}

// ─── Intent label helper ──────────────────────────────────────────────────────

function formatIntentLabel(intent: string): string {
  const labels: Record<string, string> = {
    variation_approval: 'Variation approval',
    variation_rejection: 'Variation rejection',
    quote_acceptance: 'Quote acceptance',
    quote_question: 'Quote query',
    invoice_payment: 'Payment confirmation',
    invoice_dispute: 'Invoice query',
    delivery_eta: 'Delivery ETA',
    new_quote_request: 'New quote request',
    general_reply: 'General reply',
    unrelated: 'General',
  }
  return labels[intent] ?? intent
}

// ─── Short address label ──────────────────────────────────────────────────────

function shortAddress(address: string): string {
  // Extract suburb: "14 Merri St, Fitzroy VIC 3065" → "Fitzroy"
  const match = address.match(/,\s*([^,]+?)(?:\s+VIC|\s+NSW|\s+QLD|\s+WA|\s+SA|\s+TAS|\s+ACT|\s+NT)?\s+\d{4}/i)
  if (match) return match[1].trim()
  // fallback: last word before postcode
  const parts = address.split(/[,\s]+/)
  return parts[parts.length - 2] ?? address
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function InboundEmailAlert({
  email,
  job_address,
  intent,
  suggested_action,
  onReply,
  onDismiss,
}: InboundEmailAlertProps) {
  const suburb = shortAddress(job_address)
  const intentLabel = formatIntentLabel(intent)
  const hasReplyDraft = suggested_action?.type === 'draft_reply' && suggested_action.draft

  return (
    <div className="my-3 rounded-xl border border-blue-200 bg-blue-50 overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2.5 px-4 py-2.5 bg-blue-100 border-b border-blue-200">
        <svg
          className="w-4 h-4 text-blue-600 flex-shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
          />
        </svg>
        <span className="text-sm font-semibold text-blue-800">
          New email matched to {suburb} job
        </span>
      </div>

      {/* ── Email details ───────────────────────────────────────────── */}
      <div className="px-4 py-3 space-y-1.5">
        <div className="grid grid-cols-[4rem,1fr] gap-x-2 text-sm">
          <span className="text-slate-400 font-medium">From</span>
          <span className="text-slate-700 truncate">{email.from}</span>
        </div>
        <div className="grid grid-cols-[4rem,1fr] gap-x-2 text-sm">
          <span className="text-slate-400 font-medium">Subject</span>
          <span className="text-slate-700 truncate">{email.subject}</span>
        </div>
        <div className="grid grid-cols-[4rem,1fr] gap-x-2 text-sm">
          <span className="text-slate-400 font-medium">Intent</span>
          <span className="text-slate-700 font-medium">{intentLabel}</span>
        </div>
      </div>

      {/* ── Preview ─────────────────────────────────────────────────── */}
      <div className="mx-4 mb-3 px-3 py-2 bg-white rounded-lg border border-blue-100">
        <p className="text-sm text-slate-500 italic leading-relaxed">
          &ldquo;{email.preview.length > 80 ? `${email.preview.slice(0, 80)}…` : email.preview}&rdquo;
        </p>
        <p className="text-xs text-slate-400 mt-1">{email.received_display}</p>
      </div>

      {/* ── Logged notice + suggested action ─────────────────────── */}
      <div className="px-4 pb-3">
        <p className="text-xs text-blue-700 mb-2.5">
          WorkA has logged this email.
          {suggested_action
            ? ` Suggested: ${suggested_action.description}`
            : ' No action required.'}
        </p>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          {hasReplyDraft && (
            <button
              onClick={onReply}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 transition-colors"
            >
              Reply
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 rounded-lg bg-white border border-blue-200 text-blue-600 text-xs font-medium hover:bg-blue-50 transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}
