'use client'

import { useState } from 'react'
import { hasPermission } from '@/lib/auth/role-guard'

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
  variation_ref?: string
  labour_cost?: number
  materials_cost?: number
  submitted_by?: string
  days_pending?: number
  blocks_next_stage?: boolean
}

interface VariationCardProps {
  variation: VariationCardVariation
  onApprove: (variationId: string) => void
  onReject: (variationId: string) => void
  onViewJob?: (jobId: string) => void
  userRole?: import('@/lib/auth/role-guard').PermissionRole
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatAUD(amount: number): string {
  return `$${amount.toLocaleString('en-AU')}`
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'approved':
      return 'bg-[rgba(76,175,80,0.15)] border border-[rgba(76,175,80,0.3)] text-[#4caf50]'
    case 'rejected':
      return 'bg-[#2a2a2a] border border-[#2e2e2e] text-[#555555]'
    case 'draft':
      return 'bg-[#2a2a2a] border border-[#2e2e2e] text-[#555555]'
    case 'pending':
    default:
      return 'bg-[rgba(255,152,0,0.15)] border border-[rgba(255,152,0,0.3)] text-[#ff9800]'
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

export default function VariationCard({ variation, onApprove, onReject, onViewJob, userRole = 'owner' }: VariationCardProps) {
  const [localStatus, setLocalStatus] = useState(variation.status)
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null)
  const isPending = localStatus === 'pending'

  function handleApprove() {
    if (confirming !== 'approve') { setConfirming('approve'); return }
    setConfirming(null)
    setLocalStatus('approved')
    onApprove(variation.id)
  }

  function handleReject() {
    if (confirming !== 'reject') { setConfirming('reject'); return }
    setConfirming(null)
    setLocalStatus('rejected')
    onReject(variation.id)
  }

  return (
    <div
      className="bg-[#222222] border border-[#2e2e2e] rounded-[6px] p-4 mt-2 w-full max-w-sm"
      role="region"
      aria-label={`Variation: ${variation.title}`}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[#555555] text-[11px]">
          {variation.variation_ref && `${variation.variation_ref} · `}Logged {variation.created_display}
        </span>
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-[3px] text-[11px] font-medium ${statusBadgeClass(localStatus)}`}
        >
          {statusLabel(localStatus)}
        </span>
      </div>

      {/* Title */}
      <p className="text-[#e0e0e0] text-[14px] font-semibold mt-2 leading-snug">
        {variation.title}
      </p>

      {/* Description (job address) */}
      <p className="text-[#999999] text-[12px] leading-[1.5] mt-1">
        {variation.job_address}
      </p>

      {/* Amount */}
      <p className="text-[#e0e0e0] text-[20px] font-bold mt-3">{formatAUD(variation.amount)}</p>

      {/* Sub-line */}
      {(variation.labour_cost !== undefined || variation.materials_cost !== undefined) && (
        <p className="text-[#555555] text-[11px] mt-0.5">
          inc. GST
          {variation.labour_cost !== undefined && ` · Labour ${formatAUD(variation.labour_cost)}`}
          {variation.materials_cost !== undefined && ` · Materials ${formatAUD(variation.materials_cost)}`}
        </p>
      )}

      {/* Footer row */}
      <div className="border-t border-[#2e2e2e] mt-3.5 pt-2.5 grid grid-cols-3 gap-2">
        <div>
          <p className="text-[#555555] text-[10px] uppercase tracking-[0.06em]">Submitted by</p>
          <p className="text-[#999999] text-[12px] font-medium">{variation.submitted_by ?? '—'}</p>
        </div>
        <div>
          <p className="text-[#555555] text-[10px] uppercase tracking-[0.06em]">Days pending</p>
          <p className="text-[#ff6b2b] text-[12px] font-medium">{variation.days_pending ?? '—'}</p>
        </div>
        <div>
          <p className="text-[#555555] text-[10px] uppercase tracking-[0.06em]">Contract impact</p>
          <p className="text-[#e0e0e0] text-[12px] font-medium">{formatAUD(variation.amount)}</p>
        </div>
      </div>
      {/* Blocks next stage — red-tinted row when true */}
      {variation.blocks_next_stage && (
        <div
          className="mt-2 px-2.5 py-2 rounded-[4px] flex items-center gap-2"
          style={{ backgroundColor: 'rgba(244,67,54,0.08)', border: '0.5px solid rgba(244,67,54,0.3)' }}
        >
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: '#f44336' }} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
          <p className="text-[12px] font-semibold" style={{ color: '#f44336' }}>Blocks next stage: YES</p>
        </div>
      )}

      {/* Actions */}
      {isPending && hasPermission(userRole ?? 'owner', 'site_manager') ? (
        <div className="space-y-2 mt-3">
          {confirming === 'approve' && (
            <div className="flex items-center gap-2 bg-[rgba(76,175,80,0.1)] border border-[rgba(76,175,80,0.3)] rounded-[4px] px-3 py-2">
              <p className="flex-1 text-[12px] font-medium text-[#4caf50]">Confirm approve {formatAUD(variation.amount)}?</p>
              <button type="button" onClick={handleApprove} className="text-[12px] font-semibold text-[#4caf50] bg-[rgba(76,175,80,0.2)] border border-[rgba(76,175,80,0.3)] rounded-[4px] px-2 py-1">Yes</button>
              <button type="button" onClick={() => setConfirming(null)} className="text-[12px] font-medium text-[#999999]">Cancel</button>
            </div>
          )}
          {confirming === 'reject' && (
            <div className="flex items-center gap-2 bg-[#2a2a2a] border border-[#2e2e2e] rounded-[4px] px-3 py-2">
              <p className="flex-1 text-[12px] font-medium text-[#999999]">Confirm reject?</p>
              <button type="button" onClick={handleReject} className="text-[12px] font-semibold text-[#999999] bg-[#2a2a2a] border border-[#2e2e2e] rounded-[4px] px-2 py-1">Yes</button>
              <button type="button" onClick={() => setConfirming(null)} className="text-[12px] font-medium text-[#555555]">Cancel</button>
            </div>
          )}
          {!confirming && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleApprove}
                className="flex-1 bg-[rgba(76,175,80,0.2)] text-[#4caf50] border border-[rgba(76,175,80,0.3)] text-[12px] font-semibold px-3 py-2 rounded-[4px]"
              >
                Approve {formatAUD(variation.amount)}
              </button>
              <button
                type="button"
                onClick={handleReject}
                className="bg-[#2a2a2a] text-[#999999] border border-[#2e2e2e] text-[12px] px-3 py-2 rounded-[4px]"
              >
                Reject
              </button>
              {onViewJob && variation.job_id && (
                <button
                  type="button"
                  onClick={() => onViewJob(variation.job_id!)}
                  className="px-3 py-2 text-[12px] font-medium text-[#ff6b2b] flex items-center gap-1 whitespace-nowrap"
                >
                  Details
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>
      ) : isPending ? (
        <p className="text-[12px] text-[#555555] italic mt-3">Approval requires Site Manager access</p>
      ) : (
        <div className="flex items-center gap-2 mt-3">
          {localStatus === 'approved' ? (
            <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#4caf50]">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              Approved
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[#555555]">
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
