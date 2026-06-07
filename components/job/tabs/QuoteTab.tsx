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
    case 'draft':          return 'Draft'
    case 'pending_review': return 'Pending review'
    case 'sent':           return 'Sent'
    case 'approved':       return 'Approved'
    case 'rejected':       return 'Rejected'
    default:               return status
  }
}

function confidenceCssColor(score: number): string {
  if (score >= 75) return 'var(--status-green)'
  if (score >= 50) return 'var(--status-amber)'
  return 'var(--status-red)'
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function QuoteTab({ quote, onViewQuote, onActivateJob, onStartQuote, userRole = 'owner' }: QuoteTabProps) {
  // ── No quote ───────────────────────────────────────────────────────────────
  if (!quote) {
    return (
      <div className="p-4 space-y-4">
        <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          No quote yet — upload your plans to get started.
        </p>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-[13px] font-medium transition-colors"
          style={{ color: 'var(--orange-primary)' }}
          onClick={onStartQuote}
        >
          Upload plans &amp; start quote
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
  const score = quote.confidence_score ?? 0
  const dotColor = confidenceCssColor(score)

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div>
        <p className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          Quote v{quote.version}
        </p>
        {quote.quote_ref && (
          <p className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--orange-primary)' }}>
            {quote.quote_ref}
          </p>
        )}
        {quote.sent_at ? (
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            Sent {quote.sent_at} &middot; Awaiting response
          </p>
        ) : (
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>Not yet sent</p>
        )}
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>Total</span>
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {quote.total_cost !== null ? formatCurrency(quote.total_cost) : '—'}
        </span>

        <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>Confidence</span>
        <span className="text-[13px] font-medium flex items-center gap-1.5" style={{ color: dotColor }}>
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: dotColor }}
            aria-hidden="true"
          />
          {quote.confidence_score !== null ? `${quote.confidence_score}%` : '—'}
        </span>

        <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>Status</span>
        <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
          {formatStatus(quote.status ?? '')}
        </span>
      </div>

      {/* Unresolved assumptions warning */}
      {quote.unresolved_count > 0 && (
        <div
          className="rounded-md px-3 py-2"
          style={{
            backgroundColor: 'var(--pill-awaiting-bg)',
            border: '0.5px solid var(--pill-awaiting-border)',
          }}
        >
          <p className="text-[11px]" style={{ color: 'var(--pill-awaiting-text)' }}>
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
          className="inline-flex items-center gap-1.5 text-[13px] font-medium transition-colors"
          style={{ color: 'var(--orange-primary)' }}
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
          <div className="pt-4 mt-1" style={{ borderTop: '0.5px solid var(--bg-border)' }}>
            <p className="text-[11px] mb-2.5" style={{ color: 'var(--text-secondary)' }}>Client approved?</p>
            <button
              type="button"
              onClick={() => onActivateJob(quote.id!)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors"
              style={{ backgroundColor: 'var(--orange-primary)', color: '#fff' }}
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
