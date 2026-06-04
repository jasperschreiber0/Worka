'use client'

import { useState } from 'react'
import type { JobSnapshot } from '@/lib/job-snapshot-demo'
import { hasPermission, type PermissionRole } from '@/lib/auth/role-guard'

// ─── Props ────────────────────────────────────────────────────────────────────

interface VariationsTabProps {
  variations: JobSnapshot['variations']
  jobAddress?: string
  userRole?: PermissionRole
  builderId?: string
  onApprove?: (variationId: string) => void
  onReject?: (variationId: string) => void
}

// ─── Types ────────────────────────────────────────────────────────────────────

type VariationStatus = 'draft' | 'pending' | 'approved' | 'rejected'

interface VariationWithLocalStatus {
  id: string
  title: string
  amount: number
  status: string
  created_at: string
  localStatus: VariationStatus
  variation_ref?: string
  labour_cost?: number
  materials_cost?: number
  submitted_by?: string
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
    case 'pending':
      return 'bg-amber-400'
    case 'approved':
      return 'bg-green-500'
    case 'rejected':
      return 'bg-slate-400'
    case 'draft':
    default:
      return 'bg-slate-400'
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Pending'
    case 'approved':
      return 'Approved'
    case 'rejected':
      return 'Rejected'
    case 'draft':
      return 'Draft'
    default:
      return status
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'approved':
      return 'bg-green-100 text-green-700 border-green-200'
    case 'rejected':
      return 'bg-slate-100 text-slate-500 border-slate-200'
    case 'draft':
      return 'bg-slate-100 text-slate-500 border-slate-200'
    case 'pending':
    default:
      return 'bg-amber-100 text-amber-700 border-amber-200'
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

const DEMO_BUILDER_ID = '00000000-0000-0000-0000-000000000001'

export default function VariationsTab({ variations, jobAddress, userRole = 'owner', builderId = DEMO_BUILDER_ID, onApprove, onReject }: VariationsTabProps) {
  const canApprove = hasPermission(userRole, 'site_manager')
  const [localStatuses, setLocalStatuses] = useState<Record<string, VariationStatus>>({})
  const [confirming, setConfirming] = useState<{ id: string; action: 'approve' | 'reject' } | null>(null)

  function getStatus(v: JobSnapshot['variations'][number]): VariationStatus {
    return (localStatuses[v.id] ?? v.status) as VariationStatus
  }

  async function handleApprove(variationId: string) {
    if (confirming?.id !== variationId || confirming?.action !== 'approve') {
      setConfirming({ id: variationId, action: 'approve' })
      return
    }
    setConfirming(null)
    setLocalStatuses((prev) => ({ ...prev, [variationId]: 'approved' }))
    try {
      await fetch(`/api/variations/${variationId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builder_id: builderId, action: 'approved' }),
      })
    } catch {
      setLocalStatuses((prev) => ({ ...prev, [variationId]: 'pending' }))
    }
    onApprove?.(variationId)
  }

  async function handleReject(variationId: string) {
    if (confirming?.id !== variationId || confirming?.action !== 'reject') {
      setConfirming({ id: variationId, action: 'reject' })
      return
    }
    setConfirming(null)
    setLocalStatuses((prev) => ({ ...prev, [variationId]: 'rejected' }))
    try {
      await fetch(`/api/variations/${variationId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builder_id: builderId, action: 'rejected' }),
      })
    } catch {
      setLocalStatuses((prev) => ({ ...prev, [variationId]: 'pending' }))
    }
    onReject?.(variationId)
  }

  const withLocalStatus: VariationWithLocalStatus[] = variations.map((v) => ({
    ...v,
    localStatus: getStatus(v),
  }))

  const count = withLocalStatus.length

  return (
    <div className="p-4 space-y-3">
      {/* Count header */}
      <p className="text-sm font-medium text-slate-700">
        {count === 0 ? 'No variations' : `${count} variation${count !== 1 ? 's' : ''}`}
      </p>

      {/* Variation cards */}
      {count > 0 && (
        <ul className="space-y-2">
          {withLocalStatus.map((v) => {
            const isPending = v.localStatus === 'pending'
            return (
              <li
                key={v.id}
                className={`border rounded-lg px-3 py-3 shadow-sm ${
                  v.localStatus === 'approved'
                    ? 'bg-green-50 border-green-200'
                    : v.localStatus === 'rejected'
                      ? 'bg-slate-100 border-slate-200'
                      : 'bg-amber-50 border-amber-200'
                }`}
              >
                {/* Title row */}
                <div className="flex items-start justify-between gap-2 mb-1">
                  <p className="text-sm text-slate-800 font-medium leading-snug">
                    {v.title}
                  </p>
                  <span
                    className={`flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold border ${statusBadgeClass(v.localStatus)}`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${statusDotClass(v.localStatus)}`}
                      aria-hidden="true"
                    />
                    {statusLabel(v.localStatus)}
                  </span>
                </div>

                {/* Ref + submitter */}
                {(v.variation_ref || v.submitted_by) && (
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    {v.variation_ref && (
                      <span className="text-xs font-mono font-semibold text-brand-600 bg-brand-50 px-1.5 py-0.5 rounded border border-brand-100">
                        {v.variation_ref}
                      </span>
                    )}
                    {v.submitted_by && (
                      <span className="text-xs text-slate-400">by {v.submitted_by}</span>
                    )}
                  </div>
                )}

                {/* Amount + date */}
                <p className="text-xs text-slate-500 mb-2">
                  {formatCurrency(v.amount)} &middot; {v.created_at}
                </p>

                {/* Labour/materials breakdown */}
                {(v.labour_cost !== undefined || v.materials_cost !== undefined) && (
                  <div className="flex gap-3 mb-1.5">
                    {v.labour_cost !== undefined && (
                      <span className="text-xs text-slate-500">
                        Labour: <span className="font-medium">{formatCurrency(v.labour_cost)}</span>
                      </span>
                    )}
                    {v.materials_cost !== undefined && (
                      <span className="text-xs text-slate-500">
                        Materials: <span className="font-medium">{formatCurrency(v.materials_cost)}</span>
                      </span>
                    )}
                  </div>
                )}

                {/* Actions for pending variations */}
                {isPending && canApprove && (
                  <div className="mt-2 space-y-2">
                    {confirming?.id === v.id && confirming.action === 'approve' && (
                      <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                        <p className="flex-1 text-xs font-medium text-green-800">Confirm approve {formatCurrency(v.amount)}?</p>
                        <button type="button" onClick={() => void handleApprove(v.id)} className="text-xs font-semibold text-white bg-green-600 hover:bg-green-700 rounded px-2 py-1 transition-colors">Yes</button>
                        <button type="button" onClick={() => setConfirming(null)} className="text-xs font-medium text-slate-600 hover:text-slate-800 transition-colors">Cancel</button>
                      </div>
                    )}
                    {confirming?.id === v.id && confirming.action === 'reject' && (
                      <div className="flex items-center gap-2 bg-slate-100 border border-slate-300 rounded-lg px-3 py-2">
                        <p className="flex-1 text-xs font-medium text-slate-700">Confirm reject?</p>
                        <button type="button" onClick={() => void handleReject(v.id)} className="text-xs font-semibold text-white bg-slate-600 hover:bg-slate-700 rounded px-2 py-1 transition-colors">Yes</button>
                        <button type="button" onClick={() => setConfirming(null)} className="text-xs font-medium text-slate-500 hover:text-slate-700 transition-colors">Cancel</button>
                      </div>
                    )}
                    {confirming?.id !== v.id && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleApprove(v.id)}
                          className="flex-1 px-3 py-2.5 text-xs font-semibold text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
                        >
                          Approve {formatCurrency(v.amount)}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleReject(v.id)}
                          className="px-3 py-2.5 text-xs font-medium text-slate-600 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {isPending && !canApprove && (
                  <p className="text-xs text-slate-400 mt-2 italic">Approval requires site manager access or above.</p>
                )}

                {/* Status label for resolved variations */}
                {!isPending && (
                  <div className="flex items-center gap-1.5 mt-1">
                    {v.localStatus === 'approved' ? (
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-green-700">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                        Approved
                      </span>
                    ) : v.localStatus === 'rejected' ? (
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        Rejected
                      </span>
                    ) : null}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* Empty state */}
      {count === 0 && (
        <p className="text-sm text-slate-400">No scope changes on this job yet.</p>
      )}

      {/* Add variation — routes to chat */}
      <p className="text-xs text-slate-400 mt-1">
        To add a variation, type{' '}
        <span className="font-mono text-slate-600">
          &ldquo;variation for {jobAddress ? jobAddress.split(',')[0] : 'job'}&rdquo;
        </span>{' '}
        in chat.
      </p>
    </div>
  )
}
