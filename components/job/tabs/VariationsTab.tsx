'use client'

import { useState, useCallback } from 'react'
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

type VariationStatus = 'draft' | 'pending' | 'approved' | 'rejected'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  return `$${amount.toLocaleString('en-AU')}`
}

function statusPillStyle(status: VariationStatus): React.CSSProperties {
  switch (status) {
    case 'approved':
      return { backgroundColor: 'rgba(76,175,80,0.15)', border: '0.5px solid rgba(76,175,80,0.3)', color: 'var(--status-green)' }
    case 'rejected':
      return { backgroundColor: 'var(--bg-elevated)', border: '0.5px solid var(--bg-border)', color: 'var(--text-tertiary)' }
    case 'draft':
      return { backgroundColor: 'var(--bg-elevated)', border: '0.5px solid var(--bg-border)', color: 'var(--text-tertiary)' }
    case 'pending':
    default:
      return { backgroundColor: 'var(--pill-awaiting-bg)', border: '0.5px solid var(--pill-awaiting-border)', color: 'var(--pill-awaiting-text)' }
  }
}

function statusLabel(status: VariationStatus): string {
  switch (status) {
    case 'approved': return 'Approved'
    case 'rejected': return 'Rejected'
    case 'draft': return 'Draft'
    case 'pending': default: return 'Awaiting approval'
  }
}

const DEMO_BUILDER_ID = '00000000-0000-0000-0000-000000000001'

// ─── Component ────────────────────────────────────────────────────────────────

export default function VariationsTab({
  variations,
  jobAddress,
  userRole = 'owner',
  builderId = DEMO_BUILDER_ID,
  onApprove,
  onReject,
}: VariationsTabProps) {
  const canApprove = hasPermission(userRole, 'site_manager')
  const [localStatuses, setLocalStatuses] = useState<Record<string, VariationStatus>>({})
  const [confirming, setConfirming] = useState<{ id: string; action: 'approve' | 'reject' } | null>(null)
  const [shareLinks, setShareLinks] = useState<Record<string, string>>({})
  const [shareCopied, setShareCopied] = useState<string | null>(null)

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

  const handleSendToClient = useCallback(async (variationId: string) => {
    const existing = shareLinks[variationId]
    if (existing) {
      await navigator.clipboard.writeText(existing).catch(() => {})
      setShareCopied(variationId)
      setTimeout(() => setShareCopied(null), 2000)
      return
    }
    try {
      const res = await fetch(`/api/variations/${variationId}/share`, { method: 'POST' })
      const data = await res.json() as { link?: string }
      if (data.link) {
        setShareLinks((prev) => ({ ...prev, [variationId]: data.link! }))
        await navigator.clipboard.writeText(data.link).catch(() => {})
        setShareCopied(variationId)
        setTimeout(() => setShareCopied(null), 2000)
      }
    } catch { /* ignore */ }
  }, [shareLinks])

  const total = variations.reduce((sum, v) => sum + v.amount, 0)
  const pendingCount = variations.filter((v) => (localStatuses[v.id] ?? v.status) === 'pending').length

  return (
    <div style={{ padding: '16px' }}>
      {/* Summary header */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-[12px] font-medium uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>
          {variations.length === 0 ? 'No variations' : `${variations.length} variation${variations.length !== 1 ? 's' : ''}`}
          {pendingCount > 0 && <span style={{ color: 'var(--pill-awaiting-text)' }}> · {pendingCount} pending</span>}
        </p>
        {variations.length > 0 && (
          <p className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{formatCurrency(total)} total</p>
        )}
      </div>

      {/* Variation rows */}
      {variations.length > 0 && (
        <div className="space-y-2">
          {variations.map((v) => {
            const status = getStatus(v)
            const isPending = status === 'pending'
            const cardBg = isPending
              ? { backgroundColor: 'rgba(255,152,0,0.05)', border: '0.5px solid rgba(255,152,0,0.25)' }
              : { backgroundColor: 'var(--bg-surface)', border: '0.5px solid var(--bg-border)' }

            return (
              <div
                key={v.id}
                className="rounded-[6px]"
                style={{ ...cardBg, padding: '12px 14px' }}
              >
                {/* Title + status */}
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <p className="text-[13px] font-medium leading-snug" style={{ color: 'var(--text-primary)' }}>{v.title}</p>
                  <span
                    className="flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-[3px]"
                    style={statusPillStyle(status)}
                  >
                    {statusLabel(status)}
                  </span>
                </div>

                {/* Ref + submitter */}
                {(v.variation_ref || v.submitted_by) && (
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    {v.variation_ref && (
                      <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded-[3px]"
                        style={{ backgroundColor: 'rgba(255,107,43,0.1)', color: 'var(--orange-primary)', border: '0.5px solid rgba(255,107,43,0.25)' }}>
                        {v.variation_ref}
                      </span>
                    )}
                    {v.submitted_by && (
                      <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>by {v.submitted_by}</span>
                    )}
                  </div>
                )}

                {/* Amount + date */}
                <p className="text-[18px] font-bold mt-1" style={{ color: 'var(--text-primary)' }}>{formatCurrency(v.amount)}</p>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  {v.created_at}
                  {v.labour_cost !== undefined && ` · Labour ${formatCurrency(v.labour_cost)}`}
                  {v.materials_cost !== undefined && ` · Materials ${formatCurrency(v.materials_cost)}`}
                </p>

                {/* Pending actions */}
                {isPending && canApprove && (
                  <div className="mt-3 space-y-2">
                    {confirming?.id === v.id && confirming.action === 'approve' && (
                      <div className="flex items-center gap-2 rounded-[4px] px-3 py-2"
                        style={{ backgroundColor: 'rgba(76,175,80,0.1)', border: '0.5px solid rgba(76,175,80,0.3)' }}>
                        <p className="flex-1 text-[12px] font-medium" style={{ color: 'var(--status-green)' }}>Confirm approve {formatCurrency(v.amount)}?</p>
                        <button type="button" onClick={() => void handleApprove(v.id)} className="text-[12px] font-semibold rounded-[4px] px-2 py-1"
                          style={{ color: 'var(--status-green)', backgroundColor: 'rgba(76,175,80,0.2)', border: '0.5px solid rgba(76,175,80,0.3)' }}>Yes</button>
                        <button type="button" onClick={() => setConfirming(null)} className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Cancel</button>
                      </div>
                    )}
                    {confirming?.id === v.id && confirming.action === 'reject' && (
                      <div className="flex items-center gap-2 rounded-[4px] px-3 py-2"
                        style={{ backgroundColor: 'var(--bg-elevated)', border: '0.5px solid var(--bg-border)' }}>
                        <p className="flex-1 text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>Confirm reject?</p>
                        <button type="button" onClick={() => void handleReject(v.id)} className="text-[12px] font-semibold rounded-[4px] px-2 py-1"
                          style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-elevated)', border: '0.5px solid var(--bg-border)' }}>Yes</button>
                        <button type="button" onClick={() => setConfirming(null)} className="text-[12px] font-medium" style={{ color: 'var(--text-tertiary)' }}>Cancel</button>
                      </div>
                    )}
                    {confirming?.id !== v.id && (
                      <>
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => void handleApprove(v.id)}
                            className="flex-1 text-[12px] font-semibold px-3 py-2 rounded-[4px]"
                            style={{ backgroundColor: 'rgba(76,175,80,0.2)', color: 'var(--status-green)', border: '0.5px solid rgba(76,175,80,0.3)' }}>
                            Approve {formatCurrency(v.amount)}
                          </button>
                          <button type="button" onClick={() => void handleReject(v.id)}
                            className="text-[12px] px-3 py-2 rounded-[4px]"
                            style={{ backgroundColor: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '0.5px solid var(--bg-border)' }}>
                            Reject
                          </button>
                        </div>
                        <button type="button" onClick={() => void handleSendToClient(v.id)}
                          className="w-full text-[11px] font-medium px-3 py-1.5 rounded-[4px] flex items-center justify-center gap-1"
                          style={{ backgroundColor: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: '0.5px solid var(--bg-border)' }}>
                          {shareCopied === v.id ? '✓ Link copied!' : shareLinks[v.id] ? 'Copy client approval link' : 'Send to client for approval →'}
                        </button>
                        {shareLinks[v.id] && (
                          <p className="text-[10px] break-all" style={{ color: 'var(--text-tertiary)' }}>{shareLinks[v.id]}</p>
                        )}
                      </>
                    )}
                  </div>
                )}
                {isPending && !canApprove && (
                  <p className="text-[11px] italic mt-2" style={{ color: 'var(--text-tertiary)' }}>Approval requires site manager access or above.</p>
                )}

                {/* Resolved state */}
                {!isPending && (
                  <div className="flex items-center gap-1.5 mt-2">
                    {status === 'approved' ? (
                      <span className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: 'var(--status-green)' }}>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                        Approved
                      </span>
                    ) : status === 'rejected' ? (
                      <span className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: 'var(--text-tertiary)' }}>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        Rejected
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Empty state */}
      {variations.length === 0 && (
        <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>No scope changes on this job yet.</p>
      )}

      {/* Hint */}
      <p className="text-[11px] mt-3" style={{ color: 'var(--text-tertiary)' }}>
        To add a variation, type{' '}
        <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
          &ldquo;variation for {jobAddress ? jobAddress.split(',')[0] : 'this job'}&rdquo;
        </span>{' '}
        in chat.
      </p>
    </div>
  )
}
