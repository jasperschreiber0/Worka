'use client'

import type { JobSnapshot } from '@/lib/job-snapshot-demo'
import { hasPermission } from '@/lib/auth/role-guard'

// ─── Props ────────────────────────────────────────────────────────────────────

interface QuoteTabProps {
  quote: JobSnapshot['quote']
  onViewQuote: (quoteId: string) => void
  onActivateJob?: (quoteId: string) => void
  onStartQuote?: () => void
  userRole?: import('@/lib/auth/role-guard').PermissionRole
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatStatus(status: string): string {
  switch (status) {
    case 'draft':
      return 'Draft'
    case 'pending_review':
      return 'Pending review'
    case 'sent':
      return 'Sent'
    case 'approved':
      return 'Approved'
    case 'rejected':
      return 'Rejected'
    default:
      return status
  }
}

function confidenceColour(score: number): string {
  if (score >= 75) return 'text-green-500'
  if (score >= 50) return 'text-amber-500'
  return 'text-red-500'
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function QuoteTab({ quote, onViewQuote, onActivateJob, onStartQuote, userRole = 'owner' }: QuoteTabProps) {
  // ── No quote ───────────────────────────────────────────────────────────────
  if (!quote) {
    return (
      <div className="p-4 space-y-4">
        <p className="text-sm text-slate-500">No quote yet — upload your plans to get started.</p>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors"
          onClick={onStartQuote}
        >
          Upload plans & start quote
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
          </svg>
        </button>
      </div>
    )
  }

  // ── Quote exists ───────────────────────────────────────────────────────────
  const dotColour = confidenceColour(quote.confidence_score ?? 0)

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div>
        <p className="text-sm font-semibold text-slate-800">Quote v{quote.version}</p>
        {quote.quote_ref && (
          <p className="text-xs font-mono text-brand-600 mt-0.5">{quote.quote_ref}</p>
        )}
        {quote.sent_at ? (
          <p className="text-xs text-slate-500 mt-0.5">
            Sent {quote.sent_at} &middot; Awaiting response
          </p>
        ) : (
          <p className="text-xs text-slate-500 mt-0.5">Not yet sent</p>
        )}
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <span className="text-sm text-slate-500">Total</span>
        <span className="text-sm text-slate-800 font-semibold">
          {quote.total_cost !== null ? formatCurrency(quote.total_cost) : '—'}
        </span>

        <span className="text-sm text-slate-500">Confidence</span>
        <span className={`text-sm font-medium flex items-center gap-1.5 ${dotColour}`}>
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              (quote.confidence_score ?? 0) >= 75
                ? 'bg-green-500'
                : (quote.confidence_score ?? 0) >= 50
                  ? 'bg-amber-500'
                  : 'bg-red-500'
            }`}
            aria-hidden="true"
          />
          {quote.confidence_score !== null ? `${quote.confidence_score}%` : '—'}
        </span>

        <span className="text-sm text-slate-500">Status</span>
        <span className="text-sm text-slate-700">{formatStatus(quote.status ?? '')}</span>
      </div>

      {/* Unresolved assumptions warning */}
      {quote.unresolved_count > 0 && (
        <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2">
          <p className="text-xs text-amber-800">
            {quote.unresolved_count} assumption{quote.unresolved_count !== 1 ? 's' : ''} need your
            review before this quote can be sent.
          </p>
        </div>
      )}

      {/* Action button */}
      {quote.id && (
        <button
          type="button"
          onClick={() => onViewQuote(quote.id!)}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors"
        >
          View quote
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
          </svg>
        </button>
      )}

      {/* Activation trigger — show when quote is sent or approved, owner role only */}
      {quote.id && onActivateJob && (quote.status === 'sent' || quote.status === 'approved') && hasPermission(userRole ?? 'owner', 'owner') && (
        <div className="pt-1">
          <div className="border-t border-slate-200 pt-4 mt-1">
            <p className="text-xs text-slate-500 mb-2.5">Client approved?</p>
            <button
              type="button"
              onClick={() => onActivateJob(quote.id!)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-500 text-white text-sm font-semibold hover:bg-brand-600 transition-colors shadow-sm"
            >
              Activate job
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
