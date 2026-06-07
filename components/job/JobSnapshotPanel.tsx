'use client'

import { useState, useEffect, useCallback } from 'react'
import type { JobSnapshot } from '@/lib/job-snapshot-demo'
import type { PermissionRole } from '@/lib/auth/role-guard'
import ActivationModal, { type ActivationResult } from '@/components/job/ActivationModal'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActiveJob {
  id: string
  address: string
  status: string
  client_name?: string
}

export interface JobSnapshotPanelProps {
  job: ActiveJob | null
  onClose: () => void
  userRole?: PermissionRole
  builderId?: string
  onViewQuote?: (quoteId: string) => void
  onVariationApprove?: (variationId: string) => void
  onComposeEmail?: (jobId: string) => void
  onUploadPlans?: (job: ActiveJob) => void
  onAddInvoice?: (jobId: string) => void
  onJobActivated?: (jobId: string) => void
  onAddTask?: (jobAddress: string) => void
}

interface ActivationModalState {
  isOpen: boolean
  quote: JobSnapshot['quote'] | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatAUD(amount: number | null | undefined): string {
  if (amount == null) return '—'
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(amount)
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const SECTION_LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
  marginBottom: 10,
}

const HAIRLINE: React.CSSProperties = {
  borderTop: '0.5px solid var(--bg-border)',
}

const CARD_STYLE: React.CSSProperties = {
  backgroundColor: 'var(--bg-elevated)',
  borderRadius: 6,
  padding: '10px 12px',
}

function SectionGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={SECTION_LABEL_STYLE}>{label}</div>
      {children}
    </div>
  )
}

function SkeletonPanel() {
  return (
    <div style={{ padding: '16px' }}>
      {[1, 2, 3].map((i) => (
        <div key={i} style={{ marginBottom: 24 }}>
          <div style={{ height: 10, width: 64, borderRadius: 4, backgroundColor: 'var(--bg-elevated)', marginBottom: 10 }} className="animate-pulse" />
          <div style={{ ...CARD_STYLE, padding: '12px' }}>
            <div style={{ height: 14, borderRadius: 4, backgroundColor: 'var(--bg-border)', marginBottom: 8 }} className="animate-pulse" />
            <div style={{ height: 14, width: '70%', borderRadius: 4, backgroundColor: 'var(--bg-border)' }} className="animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function JobSnapshotPanel({
  job,
  onClose,
  onViewQuote,
  onComposeEmail,
  onUploadPlans,
  onJobActivated,
  onAddTask,
}: JobSnapshotPanelProps) {
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [activationModal, setActivationModal] = useState<ActivationModalState>({ isOpen: false, quote: null })
  const [activatedJobStatus, setActivatedJobStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!job) {
      setSnapshot(null)
      return
    }
    setLoading(true)
    fetch(`/api/jobs/${job.id}/snapshot`)
      .then((r) => r.json())
      .then((data: { snapshot: JobSnapshot }) => {
        setSnapshot(data.snapshot)
        setLoading(false)
      })
      .catch(() => {
        setLoading(false)
      })
  }, [job?.id])

  useEffect(() => {
    setActivatedJobStatus(null)
  }, [job?.id])

  const handleActivated = useCallback(
    (result: ActivationResult) => {
      setActivationModal({ isOpen: false, quote: null })
      setActivatedJobStatus('active')
      setSnapshot((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          job: { ...prev.job, status: 'active' },
          quote: prev.quote ? { ...prev.quote, status: 'approved' } : prev.quote,
        }
      })
      onJobActivated?.(result.job.id)
    },
    [onJobActivated],
  )

  // ── Derived data ──────────────────────────────────────────────────────────

  const displayStatus = activatedJobStatus ?? job?.status ?? ''

  const statusColor =
    displayStatus === 'active'
      ? 'var(--status-green)'
      : displayStatus === 'quoted'
        ? 'var(--status-blue)'
        : displayStatus === 'quoting'
          ? 'var(--status-amber)'
          : 'var(--text-secondary)'

  const statusBg =
    displayStatus === 'active'
      ? 'rgba(76,175,80,0.12)'
      : displayStatus === 'quoted'
        ? 'rgba(33,150,243,0.12)'
        : displayStatus === 'quoting'
          ? 'rgba(255,152,0,0.12)'
          : 'var(--bg-elevated)'

  const pendingVariations = snapshot?.variations.filter((v) => v.status === 'pending') ?? []
  const overdueInvoices = snapshot?.invoices.filter((i) => i.status === 'overdue') ?? []
  const hasPending = pendingVariations.length > 0 || overdueInvoices.length > 0

  const paidSentInvoiceTotal = (snapshot?.invoices ?? [])
    .filter((i) => i.status === 'paid' || i.status === 'sent')
    .reduce((sum, i) => sum + i.amount, 0)

  const variationsTotal = (snapshot?.variations ?? []).reduce((sum, v) => sum + v.amount, 0)

  const quoteTotalCost = snapshot?.quote?.total_cost ?? null

  const invoicedPct =
    quoteTotalCost && quoteTotalCost > 0 ? Math.min(100, Math.round((paidSentInvoiceTotal / quoteTotalCost) * 100)) : null

  const recentComms = (snapshot?.comms.messages ?? []).slice(0, 3)

  const STAGES = ['Quoting', 'Quoted', 'Active', 'Complete']
  const stageMap: Record<string, number> = { quoting: 0, quoted: 1, active: 2, complete: 3, archived: 3 }
  const currentStageIndex = stageMap[displayStatus] ?? 0

  // ── Actions ───────────────────────────────────────────────────────────────

  const actions: { label: string; handler: () => void }[] = []
  if (onComposeEmail && job) actions.push({ label: 'Compose email', handler: () => onComposeEmail(job.id) })
  if (onViewQuote && snapshot?.quote?.id) actions.push({ label: 'View quote', handler: () => onViewQuote(snapshot.quote!.id!) })
  if (onUploadPlans && job) actions.push({ label: 'Upload plans', handler: () => onUploadPlans(job) })
  if (onAddTask && job) actions.push({ label: 'Add task', handler: () => onAddTask(job.address) })

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-shell)' }}>
      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <div
        style={{
          flexShrink: 0,
          padding: '14px 16px 12px',
          borderBottom: '0.5px solid var(--bg-border)',
          backgroundColor: 'var(--bg-shell)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            {/* Eyebrow */}
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 4 }}>
              Job Snapshot
            </div>
            {/* Address */}
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.2, marginBottom: 4 }}>
              {job?.address ?? 'No job selected'}
            </div>
            {/* Subtitle row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {job && (
                <>
                  <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                    {[snapshot?.job.job_type, snapshot?.job.job_ref].filter(Boolean).join(' · ') || displayStatus}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      padding: '2px 6px',
                      borderRadius: 4,
                      backgroundColor: statusBg,
                      color: statusColor,
                    }}
                  >
                    {displayStatus.charAt(0).toUpperCase() + displayStatus.slice(1)}
                  </span>
                </>
              )}
            </div>
          </div>
          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close job snapshot"
            style={{
              flexShrink: 0,
              width: 28,
              height: 28,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-tertiary)',
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.color = 'var(--text-secondary)'
              e.currentTarget.style.backgroundColor = 'var(--bg-elevated)'
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.color = 'var(--text-tertiary)'
              e.currentTarget.style.backgroundColor = 'transparent'
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── SCROLLABLE BODY ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', paddingBottom: 0 }}>
        {!job ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', textAlign: 'center', padding: '48px 16px', color: 'var(--text-tertiary)', fontSize: 13 }}>
            Ask about a specific job to see its details here.
          </div>
        ) : loading ? (
          <SkeletonPanel />
        ) : !snapshot ? (
          <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--text-tertiary)', fontSize: 13 }}>
            Job details not available yet.
          </div>
        ) : (
          <>
            {/* ── 1. CLIENT ───────────────────────────────────────────────── */}
            {snapshot.job.client_name && (
              <SectionGroup label="Client">
                <div style={{ ...CARD_STYLE, display: 'flex', alignItems: 'center', gap: 12 }}>
                  {/* Avatar */}
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      backgroundColor: '#2c3e50',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      fontWeight: 700,
                      color: '#ffffff',
                      flexShrink: 0,
                    }}
                  >
                    {getInitials(snapshot.job.client_name)}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{snapshot.job.client_name}</div>
                    {snapshot.job.client_email && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                          <rect x="2" y="4" width="20" height="16" rx="2" />
                          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                        </svg>
                        {snapshot.job.client_email}
                      </div>
                    )}
                    {snapshot.job.client_phone && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.72 12 19.79 19.79 0 0 1 1.61 3.39 2 2 0 0 1 3.58 1.21h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.96a16 16 0 0 0 5.59 5.59l1.24-1.24a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21.58 15z" />
                        </svg>
                        {snapshot.job.client_phone}
                      </div>
                    )}
                  </div>
                </div>
              </SectionGroup>
            )}

            {/* ── 2. FINANCIALS ───────────────────────────────────────────── */}
            <SectionGroup label="Financials">
              <div style={CARD_STYLE}>
                {/* Contract row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Contract</span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{formatAUD(quoteTotalCost)}</span>
                </div>
                {/* Variations row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Variations</span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: variationsTotal > 0 ? 'var(--status-amber)' : 'var(--text-primary)' }}>
                    {variationsTotal > 0 ? formatAUD(variationsTotal) : '—'}
                  </span>
                </div>
                {/* Invoiced row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: quoteTotalCost ? 12 : 0 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Invoiced</span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{formatAUD(paidSentInvoiceTotal)}</span>
                </div>
                {/* Progress bar */}
                {quoteTotalCost != null && quoteTotalCost > 0 && (
                  <>
                    <div
                      style={{
                        height: 3,
                        borderRadius: 2,
                        backgroundColor: 'var(--bg-border)',
                        overflow: 'hidden',
                        marginBottom: 6,
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${invoicedPct ?? 0}%`,
                          backgroundColor: 'var(--orange-primary)',
                          borderRadius: 2,
                        }}
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{invoicedPct ?? 0}% invoiced</span>
                      <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                        {formatAUD(quoteTotalCost - paidSentInvoiceTotal)} remaining
                      </span>
                    </div>
                  </>
                )}
              </div>
            </SectionGroup>

            {/* ── 3. TIMELINE ─────────────────────────────────────────────── */}
            <SectionGroup label="Timeline">
              <div style={{ ...CARD_STYLE, display: 'flex', gap: 0 }}>
                {STAGES.map((stage, idx) => {
                  const isComplete = idx < currentStageIndex
                  const isCurrent = idx === currentStageIndex
                  const isPending = idx > currentStageIndex
                  return (
                    <div key={stage} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
                      {/* Connector line */}
                      {idx < STAGES.length - 1 && (
                        <div
                          style={{
                            position: 'absolute',
                            top: 4,
                            left: '50%',
                            width: '100%',
                            height: 1,
                            backgroundColor: isComplete || isCurrent ? 'var(--orange-primary)' : 'var(--bg-border)',
                            opacity: isComplete ? 0.5 : isCurrent ? 1 : 1,
                          }}
                        />
                      )}
                      {/* Dot */}
                      <div
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          backgroundColor: isComplete
                            ? 'var(--status-green)'
                            : isCurrent
                              ? 'var(--orange-primary)'
                              : 'transparent',
                          border: isPending ? '1px solid var(--bg-border)' : 'none',
                          position: 'relative',
                          zIndex: 1,
                          marginBottom: 6,
                        }}
                      />
                      {/* Label */}
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: isCurrent ? 500 : 400,
                          color: isComplete
                            ? 'var(--text-secondary)'
                            : isCurrent
                              ? 'var(--text-primary)'
                              : 'var(--bg-ghost, var(--text-tertiary))',
                          textAlign: 'center',
                        }}
                      >
                        {stage}
                      </span>
                      {isCurrent && (
                        <span style={{ fontSize: 10, color: 'var(--orange-primary)', marginTop: 2 }}>← now</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </SectionGroup>

            {/* ── 4. PENDING ACTIONS ──────────────────────────────────────── */}
            {hasPending && (
              <SectionGroup label="Pending">
                <div style={{ ...CARD_STYLE, padding: 0, overflow: 'hidden' }}>
                  {pendingVariations.map((v, idx) => (
                    <div
                      key={v.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 12px',
                        borderTop: idx === 0 ? 'none' : '0.5px solid var(--bg-border)',
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginRight: 6 }}>{v.variation_ref ?? 'VAR'}</span>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {v.title}
                        </span>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', marginLeft: 8, flexShrink: 0 }}>{formatAUD(v.amount)}</span>
                    </div>
                  ))}
                  {overdueInvoices.map((inv, idx) => (
                    <div
                      key={inv.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 12px',
                        borderTop: (pendingVariations.length > 0 || idx > 0) ? '0.5px solid var(--bg-border)' : 'none',
                      }}
                    >
                      <div>
                        <span style={{ fontSize: 10, color: 'var(--status-amber)', marginRight: 6 }}>OVERDUE</span>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Invoice due {inv.due_date}</span>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', marginLeft: 8, flexShrink: 0 }}>{formatAUD(inv.amount)}</span>
                    </div>
                  ))}
                </div>
              </SectionGroup>
            )}

            {/* ── 5. CREW ON SITE ─────────────────────────────────────────── */}
            {snapshot.workers.length > 0 && (
              <SectionGroup label="Crew on site">
                <div style={{ ...CARD_STYLE, padding: 0, overflow: 'hidden' }}>
                  {snapshot.workers.map((w, idx) => (
                    <div
                      key={w.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '7px 12px',
                        borderTop: idx === 0 ? 'none' : '0.5px solid var(--bg-border)',
                      }}
                    >
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{w.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{w.role}</span>
                    </div>
                  ))}
                </div>
              </SectionGroup>
            )}

            {/* ── 6. RECENT COMMS ─────────────────────────────────────────── */}
            {recentComms.length > 0 && (
              <SectionGroup label="Comms">
                <div style={{ ...CARD_STYLE, padding: 0, overflow: 'hidden' }}>
                  {recentComms.map((msg, idx) => (
                    <div
                      key={msg.id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                        padding: '8px 12px',
                        borderTop: idx === 0 ? 'none' : '0.5px solid var(--bg-border)',
                      }}
                    >
                      {/* Dot */}
                      <div
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          backgroundColor: idx === 0 ? 'var(--status-green)' : 'var(--text-tertiary)',
                          marginTop: 3,
                          flexShrink: 0,
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {msg.subject ?? msg.preview}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>{msg.timestamp}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </SectionGroup>
            )}

            {/* Bottom spacing before sticky footer */}
            <div style={{ height: 64 }} />
          </>
        )}
      </div>

      {/* ── STICKY FOOTER ACTIONS ────────────────────────────────────────────── */}
      {job && actions.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            ...HAIRLINE,
            backgroundColor: 'var(--bg-shell)',
            padding: '10px 16px',
            display: 'flex',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          {actions.slice(0, 4).map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.handler}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                fontSize: 12,
                color: 'var(--orange-primary)',
                fontWeight: 500,
              }}
              onMouseOver={(e) => { e.currentTarget.style.opacity = '0.75' }}
              onMouseOut={(e) => { e.currentTarget.style.opacity = '1' }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {/* ── ACTIVATION MODAL ─────────────────────────────────────────────────── */}
      {activationModal.isOpen && activationModal.quote && job && (
        <ActivationModal
          isOpen={activationModal.isOpen}
          onClose={() => setActivationModal({ isOpen: false, quote: null })}
          onActivated={handleActivated}
          job={{ id: job.id, address: job.address }}
          quote={{
            id: activationModal.quote.id!,
            total_cost: activationModal.quote.total_cost ?? 0,
            version: activationModal.quote.version,
          }}
          builderId="00000000-0000-0000-0000-000000000001"
        />
      )}
    </div>
  )
}
