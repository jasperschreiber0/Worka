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

function statusDotClass(status: string): string {
  switch (status) {
    case 'overdue':
      return 'bg-red-500'
    case 'sent':
      return 'bg-amber-400'
    case 'paid':
      return 'bg-green-500'
    case 'draft':
    default:
      return 'bg-slate-400'
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'overdue':
      return 'Overdue'
    case 'sent':
      return 'Sent'
    case 'paid':
      return 'Paid'
    case 'draft':
      return 'Draft'
    default:
      return status
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function InvoicesTab({ invoices, onAddInvoice }: InvoicesTabProps) {
  const count = invoices.length

  return (
    <div className="p-4 space-y-3">
      {/* Count header */}
      <p className="text-sm font-medium text-slate-700">
        {count === 0 ? 'No invoices' : `${count} invoice${count !== 1 ? 's' : ''}`}
      </p>

      {/* Invoice cards */}
      {count > 0 && (
        <ul className="space-y-2">
          {invoices.map((inv) => (
            <li
              key={inv.id}
              className="bg-white border border-slate-200 rounded-lg px-3 py-3 flex items-start justify-between gap-3 shadow-sm"
            >
              <div className="min-w-0">
                <p className="text-sm text-slate-800 font-semibold">
                  {formatCurrency(inv.amount)}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  Due {inv.due_date}
                  {inv.sent_at && <> &middot; Sent {inv.sent_at}</>}
                </p>
              </div>
              <div className="flex-shrink-0 flex items-center gap-1.5 mt-0.5">
                <span
                  className={`w-2.5 h-2.5 rounded-full ${statusDotClass(inv.status)}`}
                  aria-label={statusLabel(inv.status)}
                  title={statusLabel(inv.status)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Empty state */}
      {count === 0 && (
        <p className="text-sm text-slate-400">No invoices on this job yet.</p>
      )}

      {/* Add invoice button */}
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors mt-1"
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
