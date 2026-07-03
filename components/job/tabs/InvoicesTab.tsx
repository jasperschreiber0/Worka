'use client'

import type { JobSnapshot } from '@/lib/job-snapshot-demo'

// ─── Props ────────────────────────────────────────────────────────────────────

interface InvoicesTabProps {
  invoices: JobSnapshot['invoices']
  onAddInvoice?: () => void
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

function statusDotColor(status: string): string {
  switch (status) {
    case 'overdue': return 'var(--status-red)'
    case 'sent':    return 'var(--status-amber)'
    case 'paid':    return 'var(--status-green)'
    default:        return 'var(--text-tertiary)'
  }
}

function statusTextColor(status: string): string {
  switch (status) {
    case 'overdue': return 'var(--status-red)'
    case 'paid':    return 'var(--status-green)'
    case 'sent':    return 'var(--status-amber)'
    default:        return 'var(--text-secondary)'
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'overdue': return 'Overdue'
    case 'sent':    return 'Sent'
    case 'paid':    return 'Paid'
    case 'draft':   return 'Draft'
    default:        return status
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function InvoicesTab({ invoices, onAddInvoice }: InvoicesTabProps) {
  const count = invoices.length

  return (
    <div className="p-4 space-y-3">
      {/* Count header */}
      <p className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
        {count === 0 ? 'No invoices' : `${count} invoice${count !== 1 ? 's' : ''}`}
      </p>

      {/* Invoice cards */}
      {count > 0 && (
        <ul className="space-y-2">
          {invoices.map((inv) => (
            <li
              key={inv.id}
              className="rounded-lg px-3 py-3 flex items-start justify-between gap-3"
              style={{ backgroundColor: 'var(--bg-surface)', border: '0.5px solid var(--bg-border)' }}
            >
              <div className="min-w-0">
                <p className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {formatCurrency(inv.amount)}
                </p>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  Due {inv.due_date}
                  {inv.sent_at && <> &middot; Sent {inv.sent_at}</>}
                </p>
              </div>
              <div className="flex-shrink-0 flex items-center gap-1.5 mt-0.5">
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: statusDotColor(inv.status) }}
                  aria-hidden="true"
                />
                <span
                  className="text-[11px] font-medium"
                  style={{ color: statusTextColor(inv.status) }}
                >
                  {statusLabel(inv.status)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Empty state */}
      {count === 0 && (
        <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>No invoices on this job yet.</p>
      )}

      {/* Add invoice button */}
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-[13px] font-medium transition-colors mt-1"
        style={{ color: 'var(--orange-primary)' }}
        onClick={onAddInvoice}
      >
        Add invoice
        <svg
          className="w-3.5 h-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
      </button>
    </div>
  )
}
