'use client'

import { useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VariationCardVariation {
  id: string
  title: string
  description: string
  amount: number
  status: string
  job_address: string
  created_display: string
  job_id?: string
}

interface VariationCardProps {
  variation: VariationCardVariation
  onApprove: (variationId: string) => void
  onReject: (variationId: string) => void
  onViewJob?: (jobId: string) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatAUD(amount: number): string {
  return `$${amount.toLocaleString('en-AU')}`
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'approved':
      return 'bg-green-100 text-green-700 border-green-200'
    case 'rejected':
      return 'bg-slate-100 text-slate-600 border-slate-200'
    case 'draft':
      return 'bg-slate-100 text-slate-600 border-slate-200'
    case 'pending':
    default:
      return 'bg-amber-100 text-amber-700 border-amber-200'
  }
}

function cardClass(status: string): string {
  switch (status) {
    case 'approved':
      return 'bg-green-50 border border-green-200'
    case 'rejected':
      return 'bg-slate-100 border border-slate-200'
    default:
      return 'bg-amber-50 border border-amber-200'
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'approved':
      return 'Approved'
    case 'rejected':
      return 'Rejected'
    case 'draft':
      return 'Draft'
    case 'pending':
    default:
      return 'Pending'
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function VariationCard({ variation, onApprove, onReject, onViewJob }: VariationCardProps) {
  const [localStatus, setLocalStatus] = useState(variation.status)
  const isPending = localStatus === 'pending'

  function handleApprove() {
    setLocalStatus('approved')
    onApprove(variation.id)
  }

  function handleReject() {
    setLocalStatus('rejected')
    onReject(variation.id)
  }

  return (
    <div
      className={`rounded-xl p-4 mt-2 w-full max-w-sm ${cardClass(localStatus)}`}
      role="region"
      aria-label={`Variation: ${variation.title}`}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
          Variation
        </span>
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${statusBadgeClass(localStatus)}`}
        >
          {statusLabel(localStatus)}
        </span>
      </div>

      {/* Address + age */}
      <p className="text-xs text-slate-500 mb-2">
        {variation.job_address} &middot; {variation.created_display}
      </p>

      {/* Title */}
      <p className="text-sm font-semibold text-slate-900 leading-snug mb-1">
        {variation.title}
      </p>

      {/* Amount */}
      <p className="text-lg font-bold text-slate-900 mb-3">
        {formatAUD(variation.amount)}
      </p>

      {/* Actions */}
      {isPending ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleApprove}
            className="flex-1 px-3 py-1.5 text-xs font-semibold text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
          >
            Approve {formatAUD(variation.amount)}
          </button>
          <button
            type="button"
            onClick={handleReject}
            className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors"
          >
            Reject
          </button>
          {onViewJob && variation.job_id && (
            <button
              type="button"
              onClick={() => onViewJob(variation.job_id!)}
              className="px-3 py-1.5 text-xs font-medium text-brand-600 hover:text-brand-700 flex items-center gap-1 whitespace-nowrap"
            >
              Details
              <svg
                className="w-3 h-3"
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
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {localStatus === 'approved' ? (
            <span className="flex items-center gap-1.5 text-sm font-semibold text-green-700">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              Approved
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-500">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
              Rejected
            </span>
          )}
        </div>
      )}
    </div>
  )
}
