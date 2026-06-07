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

  // Status pill style
  const pillStyle: React.CSSProperties = localStatus === 'approved'
    ? { backgroundColor: 'rgba(76,175,80,0.15)', border: '0.5px solid rgba(76,175,80,0.3)', color: 'var(--status-green)' }
    : localStatus === 'rejected'
    ? { backgroundColor: 'var(--bg-elevated)', border: '0.5px solid var(--bg-border)', color: 'var(--text-tertiary)' }
    : { backgroundColor: 'var(--pill-awaiting-bg)', border: '0.5px solid var(--pill-awaiting-border)', color: 'var(--pill-awaiting-text)' }

  const pillLabel = localStatus === 'approved' ? 'Approved' : localStatus === 'rejected' ? 'Rejected' : 'Awaiting approval'

  return (
    <div
      className="rounded-[6px] mt-2 w-full max-w-sm"
      role="region"
      aria-label={`Variation: ${variation.title}`}
      style={{ backgroundColor: 'var(--bg-surface)', border: '0.5px solid var(--bg-border)', padding: '14px 16px' }}
    >
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          {variation.variation_ref && `${variation.variation_ref} · `}Logged {variation.created_display}
        </span>
        <span
          className="text-[11px] font-medium px-2 py-0.5 rounded-[3px]"
          style={pillStyle}
        >
          {pillLabel}
        </span>
      </div>

      {/* Title */}
      <p className="text-[14px] font-semibold mt-2 leading-snug" style={{ color: 'var(--text-primary)' }}>
        {variation.title}
      </p>

      {/* Description (job address) */}
      <p className="text-[12px] leading-[1.5] mt-1" style={{ color: 'var(--text-secondary)' }}>
        {variation.job_address}
      </p>

      {/* Dollar amount — largest number on the card */}
      <p className="text-[20px] font-bold mt-3" style={{ color: 'var(--text-primary)' }}>
        {formatAUD(variation.amount)}
      </p>

      {/* Sub-line */}
      {(variation.labour_cost !== undefined || variation.materials_cost !== undefined) && (
        <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
          inc. GST
          {variation.labour_cost !== undefined && ` · Labour ${formatAUD(variation.labour_cost)}`}
          {variation.materials_cost !== undefined && ` · Materials ${formatAUD(variation.materials_cost)}`}
        </p>
      )}

      {/* Footer metadata — three columns */}
      <div className="grid grid-cols-3 gap-2 mt-[14px] pt-[10px]" style={{ borderTop: '0.5px solid var(--bg-border)' }}>
        <div>
          <p className="text-[10px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>Submitted by</p>
          <p className="text-[12px] font-medium mt-0.5" style={{ color: 'var(--text-secondary)' }}>{variation.submitted_by ?? '—'}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>Days pending</p>
          <p className="text-[12px] font-medium mt-0.5" style={{ color: 'var(--orange-primary)' }}>{variation.days_pending ?? '—'}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>Contract impact</p>
          <p className="text-[12px] font-medium mt-0.5" style={{ color: 'var(--text-primary)' }}>+{formatAUD(variation.amount)}</p>
        </div>
      </div>

      {/* Blocks next stage — red-tinted container */}
      {variation.blocks_next_stage && (
        <div
          className="mt-2 px-2.5 py-2 rounded-[4px] flex items-center gap-2"
          style={{ backgroundColor: 'rgba(244,67,54,0.08)', border: '0.5px solid rgba(244,67,54,0.3)' }}
        >
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: 'var(--status-red)' }} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
          <p className="text-[12px] font-semibold" style={{ color: 'var(--status-red)' }}>Blocks next stage: YES</p>
        </div>
      )}

      {/* Actions */}
      {isPending && hasPermission(userRole ?? 'owner', 'site_manager') ? (
        <div className="space-y-2 mt-3">
          {confirming === 'approve' && (
            <div className="flex items-center gap-2 rounded-[4px] px-3 py-2" style={{ backgroundColor: 'rgba(76,175,80,0.1)', border: '0.5px solid rgba(76,175,80,0.3)' }}>
              <p className="flex-1 text-[12px] font-medium" style={{ color: 'var(--status-green)' }}>Confirm approve {formatAUD(variation.amount)}?</p>
              <button type="button" onClick={handleApprove} className="text-[12px] font-semibold rounded-[4px] px-2 py-1" style={{ color: 'var(--status-green)', backgroundColor: 'rgba(76,175,80,0.2)', border: '0.5px solid rgba(76,175,80,0.3)' }}>Yes</button>
              <button type="button" onClick={() => setConfirming(null)} className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Cancel</button>
            </div>
          )}
          {confirming === 'reject' && (
            <div className="flex items-center gap-2 rounded-[4px] px-3 py-2" style={{ backgroundColor: 'var(--bg-elevated)', border: '0.5px solid var(--bg-border)' }}>
              <p className="flex-1 text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Confirm reject?</p>
              <button type="button" onClick={handleReject} className="text-[12px] font-semibold rounded-[4px] px-2 py-1" style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-elevated)', border: '0.5px solid var(--bg-border)' }}>Yes</button>
              <button type="button" onClick={() => setConfirming(null)} className="text-[12px] font-medium" style={{ color: 'var(--text-tertiary)' }}>Cancel</button>
            </div>
          )}
          {!confirming && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleApprove}
                className="flex-1 text-[12px] font-semibold px-3 py-2 rounded-[4px]"
                style={{ backgroundColor: 'rgba(76,175,80,0.2)', color: 'var(--status-green)', border: '0.5px solid rgba(76,175,80,0.3)' }}
              >
                Approve {formatAUD(variation.amount)}
              </button>
              <button
                type="button"
                onClick={handleReject}
                className="text-[12px] px-3 py-2 rounded-[4px]"
                style={{ backgroundColor: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '0.5px solid var(--bg-border)' }}
              >
                Reject
              </button>
              {onViewJob && variation.job_id && (
                <button
                  type="button"
                  onClick={() => onViewJob(variation.job_id!)}
                  className="px-3 py-2 text-[12px] font-medium flex items-center gap-1 whitespace-nowrap"
                  style={{ color: 'var(--orange-primary)' }}
                >
                  Details →
                </button>
              )}
            </div>
          )}
        </div>
      ) : isPending ? (
        <p className="text-[12px] italic mt-3" style={{ color: 'var(--text-tertiary)' }}>Approval requires Site Manager access</p>
      ) : (
        <div className="flex items-center gap-2 mt-3">
          {localStatus === 'approved' ? (
            <span className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: 'var(--status-green)' }}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              Approved
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: 'var(--text-tertiary)' }}>
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
