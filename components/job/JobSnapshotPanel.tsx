'use client'
import React from 'react'
import { useState, useEffect, useCallback, useRef } from 'react'
import type { JobSnapshot } from '@/lib/job-snapshot-demo'
import { deriveTimelineSteps } from '@/lib/job-snapshot-demo'
import type { PermissionRole } from '@/lib/auth/role-guard'
import ActivationModal, { type ActivationResult } from '@/components/job/ActivationModal'
import ProofTab from '@/components/job/tabs/ProofTab'
import Timeline from '@/components/dashboard/Timeline'
import AIInsightCard from '@/components/dashboard/AIInsightCard'
import ClarifyingQuestionsPanel from '@/components/chat/ClarifyingQuestionsPanel'
import VariationCard from '@/components/chat/VariationCard'
import { TRADE_CATEGORIES, tradeCategoryName } from '@/lib/trade-taxonomy'

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
  /** Create a blank estimate for this job (no document, no AI) and open it. */
  onCreateEstimate?: (job: ActiveJob) => void
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

interface CostEntry {
  id: string
  trade_category_id: number | null
  description: string
  amount: number
  incurred_on: string
  created_at: string
}

// ─── Count-up hook ────────────────────────────────────────────────────────────

function useCountUp(target: number | null | undefined, duration = 600): number | null {
  const [value, setValue] = useState<number | null>(null)
  const frameRef = useRef<number | null>(null)
  const prevTargetRef = useRef<number | null>(null)

  useEffect(() => {
    if (target == null) { setValue(null); return }
    if (target === prevTargetRef.current) return
    prevTargetRef.current = target

    const start = Date.now()
    const from = 0
    const step = () => {
      const elapsed = Date.now() - start
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3) // ease-out-cubic
      setValue(Math.round(from + (target - from) * eased))
      if (progress < 1) frameRef.current = requestAnimationFrame(step)
    }
    frameRef.current = requestAnimationFrame(step)
    return () => { if (frameRef.current != null) cancelAnimationFrame(frameRef.current) }
  }, [target, duration])

  return value
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatAUD(amount: number | null | undefined): string {
  if (amount == null) return '—'
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(amount)
}

// "25 Aug" — for a job_cost_entries.incurred_on date string ("YYYY-MM-DD").
function formatShortDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`)
  if (Number.isNaN(d.getTime())) return isoDate
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
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

function SectionGroup({ label, children }: { label: string; children?: React.ReactNode }) {
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

// ─── Aggregate pulse (no-job state) ──────────────────────────────────────────

interface AggregatePulse {
  active_jobs: number
  pipeline_value: number
  overdue_invoice_total: number
  pending_variations: number
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function JobSnapshotPanel({
  job,
  onClose,
  onViewQuote,
  onCreateEstimate,
  onComposeEmail,
  onUploadPlans,
  onJobActivated,
  onAddTask,
}: JobSnapshotPanelProps) {
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [activationModal, setActivationModal] = useState<ActivationModalState>({ isOpen: false, quote: null })
  const [activatedJobStatus, setActivatedJobStatus] = useState<string | null>(null)
  const [pulse, setPulse] = useState<AggregatePulse | null>(null)
  const [answeringQuestions, setAnsweringQuestions] = useState(false)
  const [clarifySubmitting, setClarifySubmitting] = useState(false)
  const [clarifyError, setClarifyError] = useState<string | null>(null)
  // See IntakeProgress.tsx's identical fix for why this exists: a 409 from
  // /clarify means another upload for this job still holds job_intake_locks
  // (normal, temporary — resolves on its own), not a real failure. This
  // component previously had its own, unfixed one-shot submit with no
  // retry, so a builder answering from the Job Snapshot Panel (rather than
  // the live upload SSE session) hit the exact same dead-end error.
  const [clarifyRetryStatus, setClarifyRetryStatus] = useState<string | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [openVariationId, setOpenVariationId] = useState<string | null>(null)
  const [variationActionError, setVariationActionError] = useState<string | null>(null)

  // Fetch aggregate pulse once for the no-job empty state
  useEffect(() => {
    if (pulse) return
    fetch('/api/dashboard')
      .then(r => r.json())
      .then((data: { stats?: { active_jobs?: number; pipeline_value?: number; overdue_invoice_total?: number; pending_variations?: number } }) => {
        if (data.stats) {
          setPulse({
            active_jobs: data.stats.active_jobs ?? 0,
            pipeline_value: data.stats.pipeline_value ?? 0,
            overdue_invoice_total: data.stats.overdue_invoice_total ?? 0,
            pending_variations: data.stats.pending_variations ?? 0,
          })
        }
      })
      .catch(() => {/* silent */})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchSnapshot = useCallback((jobId: string) => {
    setLoading(true)
    return fetch(`/api/jobs/${jobId}/snapshot`)
      .then((r) => r.json())
      .then((data: { snapshot: JobSnapshot }) => {
        setSnapshot(data.snapshot)
        setLoading(false)
        return data.snapshot
      })
      .catch(() => {
        setLoading(false)
        return null
      })
  }, [])

  useEffect(() => {
    if (!job) {
      setSnapshot(null)
      return
    }
    fetchSnapshot(job.id)
  }, [job?.id, fetchSnapshot])

  // ── Financials v1 — Live Job Money: cost entries ────────────────────────────
  const [costs, setCosts] = useState<CostEntry[]>([])
  const [costsLoading, setCostsLoading] = useState(false)
  const [logCostOpen, setLogCostOpen] = useState(false)
  const [logCostSaving, setLogCostSaving] = useState(false)
  const [logCostError, setLogCostError] = useState<string | null>(null)
  const [costDeletingId, setCostDeletingId] = useState<string | null>(null)
  const todayIso = () => new Date().toISOString().slice(0, 10)
  const [logCostFields, setLogCostFields] = useState({
    trade_category_id: '' as number | '',
    description: '',
    amount: '',
    incurred_on: todayIso(),
  })

  const fetchCosts = useCallback((jobId: string) => {
    setCostsLoading(true)
    return fetch(`/api/jobs/${jobId}/costs`)
      .then((r) => r.json())
      .then((data: { costs?: CostEntry[] }) => {
        setCosts(data.costs ?? [])
        setCostsLoading(false)
      })
      .catch(() => setCostsLoading(false))
  }, [])

  useEffect(() => {
    if (!job) {
      setCosts([])
      return
    }
    fetchCosts(job.id)
  }, [job?.id, fetchCosts])

  const handleLogCost = useCallback(async () => {
    if (!job || logCostSaving) return
    const amountNum = Number(logCostFields.amount)
    if (!logCostFields.description.trim()) { setLogCostError('Description is required'); return }
    if (!Number.isFinite(amountNum) || amountNum < 0) { setLogCostError('Amount must be 0 or more'); return }
    setLogCostSaving(true)
    setLogCostError(null)
    try {
      const res = await fetch(`/api/jobs/${job.id}/costs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trade_category_id: logCostFields.trade_category_id === '' ? null : logCostFields.trade_category_id,
          description: logCostFields.description.trim(),
          amount: amountNum,
          incurred_on: logCostFields.incurred_on,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setLogCostError(json.error ?? 'Failed to log cost — please try again.')
        return
      }
      setLogCostFields({ trade_category_id: '', description: '', amount: '', incurred_on: todayIso() })
      setLogCostOpen(false)
      // Reload both — the entry list (for the itemised list) and the
      // snapshot (the authoritative source for Actual Cost/Margin/Margin%,
      // recomputed server-side, never a client-maintained running total).
      await Promise.all([fetchCosts(job.id), fetchSnapshot(job.id)])
    } catch {
      setLogCostError('Failed to log cost — please try again.')
    } finally {
      setLogCostSaving(false)
    }
  }, [job, logCostFields, logCostSaving, fetchCosts, fetchSnapshot])

  const handleDeleteCost = useCallback(async (costId: string) => {
    if (!job || costDeletingId) return
    setCostDeletingId(costId)
    try {
      const res = await fetch(`/api/jobs/${job.id}/costs/${costId}`, { method: 'DELETE' })
      if (res.ok) {
        await Promise.all([fetchCosts(job.id), fetchSnapshot(job.id)])
      }
    } finally {
      setCostDeletingId(null)
    }
  }, [job, costDeletingId, fetchCosts, fetchSnapshot])

  useEffect(() => {
    setActivatedJobStatus(null)
    setAnsweringQuestions(false)
    setClarifyError(null)
    setClarifyRetryStatus(null)
  }, [job?.id])

  // Same fixed cadence as IntakeProgress.tsx's handleAnswerSubmit.
  const CLARIFY_RETRY_INTERVAL_MS = 5_000
  const CLARIFY_MAX_RETRY_ATTEMPTS = 24 // ~2 minutes of client-side retrying

  const handleClarifyAnswers = useCallback(
    async (answers: Array<{ question_id: string; answer: string }>) => {
      if (!job || !snapshot?.clarify_file_id) return
      setClarifySubmitting(true)
      setClarifyError(null)
      setClarifyRetryStatus(null)

      for (let attempt = 1; attempt <= CLARIFY_MAX_RETRY_ATTEMPTS; attempt++) {
        try {
          const res = await fetch(`/api/intake/${encodeURIComponent(snapshot.clarify_file_id)}/clarify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: job.id, answers }),
          })
          if (res.ok) {
            setClarifyRetryStatus(null)
            setAnsweringQuestions(false)
            await fetchSnapshot(job.id)
            setClarifySubmitting(false)
            return
          }
          if (res.status === 409 && attempt < CLARIFY_MAX_RETRY_ATTEMPTS) {
            setClarifyRetryStatus(`Finishing another upload for this job — retrying automatically… (attempt ${attempt} of ${CLARIFY_MAX_RETRY_ATTEMPTS})`)
            await new Promise((resolve) => setTimeout(resolve, CLARIFY_RETRY_INTERVAL_MS))
            continue
          }
          const body = await res.json().catch(() => ({ error: 'Could not continue' }))
          throw new Error((body as { error?: string }).error ?? 'Could not continue')
        } catch (err) {
          setClarifyRetryStatus(null)
          setClarifyError(err instanceof Error ? err.message : 'Could not continue — please try again.')
          setClarifySubmitting(false)
          return
        }
      }

      setClarifyRetryStatus(null)
      setClarifyError('Still waiting on another upload for this job to finish. Please try again in a minute.')
      setClarifySubmitting(false)
    },
    [job, snapshot?.clarify_file_id, fetchSnapshot],
  )

  const handleArchive = useCallback(async () => {
    if (!job) return
    if (!window.confirm(`Archive "${job.address}"? It'll be hidden from your job list — nothing is deleted, and this can be undone directly in the database if needed.`)) {
      return
    }
    setArchiving(true)
    try {
      const res = await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Could not archive job' }))
        throw new Error((body as { error?: string }).error ?? 'Could not archive job')
      }
      onClose()
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Could not archive job — please try again.')
    } finally {
      setArchiving(false)
    }
  }, [job, onClose])

  const handleVariationResolve = useCallback(
    async (variationId: string, action: 'approved' | 'rejected') => {
      setVariationActionError(null)
      try {
        const res = await fetch(`/api/variations/${variationId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? `Couldn't ${action === 'approved' ? 'approve' : 'reject'} variation`)
        setOpenVariationId(null)
        if (job) await fetchSnapshot(job.id)
      } catch (err) {
        setVariationActionError(err instanceof Error ? err.message : 'Something went wrong — try again.')
      }
    },
    [job, fetchSnapshot]
  )

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
  const pendingQuestions = snapshot?.pending_clarifying_questions ?? []
  const nonBlockingQuestions = snapshot?.pending_non_blocking_questions ?? []
  const hasPending = pendingVariations.length > 0 || overdueInvoices.length > 0

  const paidSentInvoiceTotal = (snapshot?.invoices ?? [])
    .filter((i) => i.status === 'paid' || i.status === 'sent')
    .reduce((sum, i) => sum + i.amount, 0)

  // Approved variations are now inside Contract Value (see the "Money"
  // section below — they've been folded into a real quote_line_items row).
  // Summing them here too would double-count the same dollars in two rows
  // right next to each other. This figure is deliberately "not yet
  // reflected in Contract Value" — draft/pending only.
  const variationsTotal = (snapshot?.variations ?? [])
    .filter((v) => v.status === 'draft' || v.status === 'pending')
    .reduce((sum, v) => sum + v.amount, 0)

  const quoteTotalCost = snapshot?.quote?.total_cost ?? null

  const invoicedPct =
    quoteTotalCost && quoteTotalCost > 0 ? Math.min(100, Math.round((paidSentInvoiceTotal / quoteTotalCost) * 100)) : null

  const recentComms = (snapshot?.comms.messages ?? []).slice(0, 3)

  // Animated count-up for financial figures
  const animatedContract = useCountUp(quoteTotalCost)
  const animatedInvoiced = useCountUp(paidSentInvoiceTotal)
  const animatedVariations = useCountUp(variationsTotal > 0 ? variationsTotal : null)

  // ── Financials v1 — Live Job Money ───────────────────────────────────────
  // All five figures are read straight from the snapshot API's own
  // deterministic calculation (app/api/jobs/[jobId]/snapshot/route.ts) —
  // this component does not recompute or cache a second copy of any of them.
  const budgetEstimate = snapshot?.job.budget_estimate ?? null
  const estimatedCost = snapshot?.quote?.total_cost ?? null // internal cost basis — distinct from contract value
  const contractValue = snapshot?.overview.contract_value ?? null // canonical client-facing price
  const actualCostLogged = snapshot?.overview.actual_cost ?? 0
  const currentMargin = snapshot?.overview.current_margin ?? null
  const currentMarginPct = snapshot?.overview.current_margin_pct ?? null
  const marginColorFor = (pct: number) => (pct >= 15 ? 'var(--status-green)' : pct >= 8 ? 'var(--status-amber)' : 'var(--status-red)')

  const animatedBudget = useCountUp(budgetEstimate)
  const animatedEstimatedCost = useCountUp(estimatedCost)
  const animatedContractValue = useCountUp(contractValue)
  const animatedActualCost = useCountUp(actualCostLogged)
  const animatedCurrentMargin = useCountUp(currentMargin)

  const timelineSteps = snapshot ? deriveTimelineSteps(snapshot) : []
  const jobHealth = snapshot?.job_health ?? null
  const healthColor =
    jobHealth?.label === 'At Risk' ? 'var(--status-red)' : jobHealth?.label === 'Watch' ? 'var(--status-amber)' : 'var(--status-green)'
  const healthBg =
    jobHealth?.label === 'At Risk' ? 'rgba(244,67,54,0.1)' : jobHealth?.label === 'Watch' ? 'rgba(255,152,0,0.1)' : 'rgba(76,175,80,0.15)'

  // What WorkA suggests doing next — surfaced once, in "At a glance" (not
  // repeated under Timeline, which now shows the stage tracker only).
  const nextAction: { label: string; timing: string | null; isUploadCta: boolean } | null =
    (['quoting', 'quoted', 'active'] as string[]).includes(displayStatus)
      ? (() => {
          if (displayStatus === 'quoting') {
            if (!snapshot?.quote) {
              return { label: 'Upload plans to start', timing: null, isUploadCta: true }
            }
            return { label: 'Send quote', timing: snapshot?.job.quote_deadline ?? null, isUploadCta: false }
          }
          if (displayStatus === 'quoted') {
            return {
              label: 'Waiting on client',
              timing: snapshot?.quote?.sent_at ? `Sent ${snapshot.quote.sent_at}` : null,
              isUploadCta: false,
            }
          }
          const nextInvoice = (snapshot?.invoices ?? []).find((i) => i.status === 'sent' || i.status === 'draft')
          return {
            label: nextInvoice ? formatAUD(nextInvoice.amount) + ' invoice due' : 'Next invoice milestone',
            timing: nextInvoice?.due_date ?? null,
            isUploadCta: false,
          }
        })()
      : null

  const confidenceScore = snapshot?.quote?.confidence_score ?? null
  const confidenceColor =
    confidenceScore == null ? 'var(--text-tertiary)' : confidenceScore >= 85 ? 'var(--status-green)' : confidenceScore >= 60 ? 'var(--status-amber)' : 'var(--status-red)'
  const unresolvedCount = snapshot?.quote?.unresolved_count ?? 0

  // ── Actions ───────────────────────────────────────────────────────────────

  const actions: { label: string; handler: () => void }[] = []
  if (onComposeEmail && job) actions.push({ label: 'Compose email', handler: () => onComposeEmail(job.id) })
  if (onViewQuote && snapshot?.quote?.id) actions.push({ label: 'View quote', handler: () => onViewQuote(snapshot.quote!.id!) })
  // No quote yet — offer the manual path alongside the document-upload one,
  // not instead of it. Neither requires the other: a blank estimate started
  // here can still have documents dropped onto it later, and AI will find
  // and add to the same quote rather than creating a second one.
  if (onCreateEstimate && job && !snapshot?.quote?.id) actions.push({ label: 'Create estimate', handler: () => onCreateEstimate(job) })
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
          {/* Archive button — soft-deletes via jobs.status='archived' (see
              /api/jobs/[jobId] DELETE), just hides the job from lists.
              Nothing is destroyed: quotes, variations, and the WorkA Proof
              trail are all untouched. */}
          {job && (
            <button
              type="button"
              onClick={handleArchive}
              disabled={archiving}
              aria-label="Archive job"
              title="Archive job"
              style={{
                flexShrink: 0,
                width: 28,
                height: 28,
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                cursor: archiving ? 'default' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-tertiary)',
                opacity: archiving ? 0.5 : 1,
              }}
              onMouseOver={(e) => {
                if (archiving) return
                e.currentTarget.style.color = 'var(--status-red)'
                e.currentTarget.style.backgroundColor = 'rgba(244,67,54,0.1)'
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.color = 'var(--text-tertiary)'
                e.currentTarget.style.backgroundColor = 'transparent'
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m3 0v13a1 1 0 01-1 1H7a1 1 0 01-1-1V6h12z" />
              </svg>
            </button>
          )}
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
          <div style={{ padding: '8px 0' }}>
            {/* Aggregate pulse — shown when no job is in context */}
            <div style={SECTION_LABEL_STYLE}>Today&apos;s Pulse</div>
            {pulse ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 24 }}>
                {[
                  { label: 'Active jobs', value: String(pulse.active_jobs), color: 'var(--text-primary)' },
                  {
                    label: 'Pipeline',
                    value: pulse.pipeline_value >= 1000
                      ? `$${Math.round(pulse.pipeline_value / 1000)}k`
                      : formatAUD(pulse.pipeline_value),
                    color: 'var(--text-primary)',
                  },
                  {
                    label: 'Overdue',
                    value: pulse.overdue_invoice_total > 0
                      ? `$${Math.round(pulse.overdue_invoice_total / 1000)}k`
                      : '—',
                    color: pulse.overdue_invoice_total > 0 ? 'var(--status-red)' : 'var(--text-tertiary)',
                  },
                  {
                    label: 'Variations',
                    value: pulse.pending_variations > 0 ? String(pulse.pending_variations) : '—',
                    color: pulse.pending_variations > 0 ? 'var(--status-amber)' : 'var(--text-tertiary)',
                  },
                ].map(stat => (
                  <div key={stat.label} style={{ ...CARD_STYLE, textAlign: 'center', padding: '12px 8px' }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: stat.color, lineHeight: 1 }}>{stat.value}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{stat.label}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ ...CARD_STYLE, height: 80, marginBottom: 24 }} className="animate-pulse" />
            )}
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center', lineHeight: 1.6 }}>
              Ask WorkA about a job to see its details here — or tap any job in chat.
            </div>
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
                    {/* Feature 15: Last contact date */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Last contact</span>
                      {snapshot.comms.messages.length > 0 ? (
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{snapshot.comms.messages[0].timestamp}</span>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Waiting on you</span>
                      )}
                    </div>
                  </div>
                </div>
              </SectionGroup>
            )}

            {/* ── JOB HEALTH — disclosed rule (highest risk severity present), not a fabricated score ── */}
            {jobHealth && (
              <SectionGroup label="Job health">
                <div style={{ ...CARD_STYLE }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: jobHealth.reasons.length > 0 ? 10 : 0 }}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '3px 8px',
                        borderRadius: 4,
                        backgroundColor: healthBg,
                        color: healthColor,
                      }}
                    >
                      {jobHealth.label}
                    </span>
                  </div>
                  {jobHealth.reasons.map((reason: string, idx: number) => (
                    <AIInsightCard key={idx} icon="risk" text={reason} />
                  ))}
                </div>
              </SectionGroup>
            )}

            {/* ── 2. AT A GLANCE — hidden only when there's genuinely nothing to show yet ── */}
            {snapshot.quote != null || nextAction != null || (quoteTotalCost != null && quoteTotalCost > 0) || variationsTotal > 0 || paidSentInvoiceTotal > 0 ? (
            <SectionGroup label="At a glance">
              <div style={CARD_STYLE}>
                {/* Value row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Value</span>
                  <span className="animate-number-in" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{formatAUD(animatedContract)}</span>
                </div>
                {/* Last activity row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Last activity</span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{snapshot.overview.last_activity || '—'}</span>
                </div>
                {/* Confidence row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Confidence</span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: confidenceColor }}>
                    {confidenceScore != null ? `${confidenceScore}%` : '—'}
                  </span>
                </div>
                {/* Missing information row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Missing information</span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: unresolvedCount > 0 ? 'var(--status-amber)' : 'var(--text-primary)' }}>
                    {unresolvedCount > 0 ? `${unresolvedCount} item${unresolvedCount === 1 ? '' : 's'}` : 'Nothing missing'}
                  </span>
                </div>
                {/* Next AI action — either the big upload CTA, or a compact accented row */}
                {nextAction?.isUploadCta && onUploadPlans && job ? (
                  <button
                    type="button"
                    onClick={() => onUploadPlans(job)}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      backgroundColor: 'var(--orange-primary)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 8,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      marginTop: 4,
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    {nextAction.label}
                  </button>
                ) : nextAction ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Next</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--orange-primary)' }}>{nextAction.label}</span>
                      {nextAction.timing && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{nextAction.timing}</span>}
                    </span>
                  </div>
                ) : null}
              </div>
            </SectionGroup>
            ) : null}

            {/* ── 2a. MONEY — Budget → Estimated Cost → Contract Value → Actual
                Costs Logged → Current Margin. Current Margin is the most
                visually prominent figure, per the product spec. Shown
                whenever there's anything to show — a budget, a quote, or a
                logged cost — not gated on variations/invoicing. ── */}
            {budgetEstimate != null || contractValue != null || actualCostLogged > 0 ? (
            <SectionGroup label="Money">
              <div style={CARD_STYLE}>
                {budgetEstimate != null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Budget</span>
                    <span className="animate-number-in" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{formatAUD(animatedBudget)}</span>
                  </div>
                )}
                {estimatedCost != null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Estimated cost</span>
                    <span className="animate-number-in" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{formatAUD(animatedEstimatedCost)}</span>
                  </div>
                )}
                {contractValue != null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Contract value</span>
                    <span className="animate-number-in" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{formatAUD(animatedContractValue)}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Actual costs logged</span>
                  <span className="animate-number-in" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{formatAUD(animatedActualCost)}</span>
                </div>
                {/* Current margin — the headline figure of this whole section */}
                {currentMargin != null && (
                  <div
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '10px 12px', borderRadius: 8,
                      backgroundColor: currentMarginPct != null ? `color-mix(in srgb, ${marginColorFor(currentMarginPct)} 12%, transparent)` : 'var(--bg-elevated)',
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Current margin</span>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span className="animate-number-in" style={{ fontSize: 16, fontWeight: 700, color: currentMarginPct != null ? marginColorFor(currentMarginPct) : 'var(--text-primary)' }}>
                        {formatAUD(animatedCurrentMargin)}
                      </span>
                      {currentMarginPct != null && (
                        <span style={{ fontSize: 12, fontWeight: 600, color: marginColorFor(currentMarginPct) }}>{currentMarginPct}%</span>
                      )}
                    </div>
                  </div>
                )}
                {currentMargin == null && (
                  <p style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: 0 }}>Margin appears once this job has an estimate.</p>
                )}
              </div>
            </SectionGroup>
            ) : null}

            {/* ── 2b. MONEY DETAIL — secondary, only when there's more than the headline Value to show ── */}
            {variationsTotal > 0 || paidSentInvoiceTotal > 0 ? (
            <SectionGroup label="Money detail">
              <div style={CARD_STYLE}>
                {/* Variations row — draft/pending only; approved variations
                    are already inside Contract Value above, not repeated here. */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Variations awaiting decision</span>
                  <span className="animate-number-in" style={{ fontSize: 12, fontWeight: 500, color: variationsTotal > 0 ? 'var(--status-amber)' : 'var(--text-primary)' }}>
                    {animatedVariations != null ? formatAUD(animatedVariations) : '—'}
                  </span>
                </div>
                {/* Invoiced row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: quoteTotalCost ? 12 : 0 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Invoiced</span>
                  <span className="animate-number-in" style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{formatAUD(animatedInvoiced)}</span>
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
            ) : null}

            {/* ── 2c. ACTUAL COSTS — the costs the builder has actually logged
                against this job. Always shown when there's a job, so "Log a
                cost" is always reachable — an empty list is a normal state
                for a new job, not an error. ── */}
            {job && (
            <SectionGroup label="Actual costs">
              <div style={CARD_STYLE}>
                {costsLoading && costs.length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: 0 }}>Loading…</p>
                ) : costs.length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 10px 0' }}>Nothing logged yet.</p>
                ) : (
                  <div style={{ marginBottom: 10 }}>
                    {costs.map((c) => (
                      <div
                        key={c.id}
                        style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '6px 0', borderBottom: '1px solid var(--bg-border)',
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {c.trade_category_id != null ? `${tradeCategoryName(c.trade_category_id)} — ` : ''}{c.description}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{formatShortDate(c.incurred_on)}</div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{formatAUD(c.amount)}</span>
                          <button
                            type="button"
                            onClick={() => handleDeleteCost(c.id)}
                            disabled={costDeletingId === c.id}
                            aria-label={`Delete ${c.description}`}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--status-red)', opacity: costDeletingId === c.id ? 0.4 : 1 }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {!logCostOpen ? (
                  <button
                    type="button"
                    onClick={() => setLogCostOpen(true)}
                    className="btn-secondary"
                    style={{ width: '100%', fontSize: 12, padding: '8px 12px' }}
                  >
                    + Log a cost
                  </button>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <select
                      value={logCostFields.trade_category_id}
                      onChange={(e) => setLogCostFields((f) => ({ ...f, trade_category_id: e.target.value === '' ? '' : Number(e.target.value) }))}
                      style={{ fontSize: 12, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
                    >
                      <option value="">No trade / other</option>
                      {TRADE_CATEGORIES.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      placeholder="Description — e.g. Plumber rough-in labour"
                      value={logCostFields.description}
                      onChange={(e) => setLogCostFields((f) => ({ ...f, description: e.target.value }))}
                      style={{ fontSize: 12, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
                    />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        placeholder="Amount $"
                        value={logCostFields.amount}
                        onChange={(e) => setLogCostFields((f) => ({ ...f, amount: e.target.value }))}
                        style={{ flex: 1, fontSize: 12, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
                      />
                      <input
                        type="date"
                        value={logCostFields.incurred_on}
                        onChange={(e) => setLogCostFields((f) => ({ ...f, incurred_on: e.target.value }))}
                        style={{ flex: 1, fontSize: 12, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
                      />
                    </div>
                    {logCostError && <p style={{ fontSize: 11, color: 'var(--status-red)', margin: 0 }}>{logCostError}</p>}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        onClick={handleLogCost}
                        disabled={logCostSaving}
                        className="btn-primary"
                        style={{ flex: 1, fontSize: 12, padding: '8px 12px', opacity: logCostSaving ? 0.6 : 1 }}
                      >
                        {logCostSaving ? 'Saving…' : 'Save cost'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setLogCostOpen(false); setLogCostError(null) }}
                        disabled={logCostSaving}
                        style={{ fontSize: 12, padding: '8px 12px', background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </SectionGroup>
            )}

            {/* ── 3. TIMELINE — real sub-steps, each backed by a real column (see lib/job-snapshot-demo.ts) ── */}
            <SectionGroup label="Timeline">
              <div style={CARD_STYLE}>
                <Timeline steps={timelineSteps} />
              </div>
            </SectionGroup>

            {/* ── 3.5. CLARIFYING QUESTIONS — Stage 4/5 raised these, but the
                 pipeline no longer pauses on them (see smooth-responder/index.ts):
                 a quote already exists, generated using a disclosed conservative
                 assumption in place of an answer. Answering here replaces that
                 assumption and reruns the pipeline to refresh the estimate. See
                 snapshot route for pending_clarifying_questions / clarify_file_id. ── */}
            {pendingQuestions.length > 0 && (
              <SectionGroup label="Needs your input">
                {answeringQuestions ? (
                  <ClarifyingQuestionsPanel
                    title="Refine this estimate"
                    submitLabel="Update estimate"
                    message="WorkA already estimated this job using its best assumption for these — answering will replace the assumption and refresh the numbers."
                    questions={pendingQuestions}
                    submitting={clarifySubmitting}
                    error={clarifyError}
                    retryStatus={clarifyRetryStatus}
                    onSubmit={handleClarifyAnswers}
                  />
                ) : (
                  <button
                    onClick={() => setAnsweringQuestions(true)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      ...CARD_STYLE,
                      border: '1px solid rgba(255,152,0,0.3)',
                      backgroundColor: 'rgba(255,152,0,0.06)',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#ff9800' }}>
                      {pendingQuestions.length} assumption{pendingQuestions.length > 1 ? 's' : ''} to review
                    </span>
                    <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3 }}>
                      WorkA already estimated using its best guess — tap to answer and refine the numbers.
                    </p>
                  </button>
                )}
              </SectionGroup>
            )}

            {/* ── 3.6. NON-BLOCKING OPEN QUESTIONS — Stage 4/5 raised these but
                 they never pause estimating; a quote can already exist. Previously
                 invisible anywhere in the builder UI (the estimating engine's own
                 clarifying_questions table always had them, but no route ever
                 surfaced non-blocking ones — see GET /api/jobs/[jobId]/snapshot's
                 pending_non_blocking_questions). Deliberately informational only,
                 no answer form: answering these doesn't change pipeline behavior
                 today, so a form implying otherwise would be misleading. ── */}
            {nonBlockingQuestions.length > 0 && (
              <SectionGroup label="Worth knowing">
                <div style={{ ...CARD_STYLE, padding: 0, overflow: 'hidden' }}>
                  {nonBlockingQuestions.map((q, idx) => (
                    <div
                      key={q.id}
                      style={{
                        padding: '10px 14px',
                        borderTop: idx > 0 ? '1px solid var(--bg-border)' : 'none',
                      }}
                    >
                      <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{q.question}</p>
                      <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{q.reason}</p>
                    </div>
                  ))}
                </div>
              </SectionGroup>
            )}

            {/* ── 4. PENDING ACTIONS ──────────────────────────────────────── */}
            {hasPending && (
              <SectionGroup label="Pending">
                <div style={{ ...CARD_STYLE, padding: 0, overflow: 'hidden' }}>
                  {pendingVariations.map((v, idx) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setOpenVariationId(v.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 12px',
                        borderTop: idx === 0 ? 'none' : '0.5px solid var(--bg-border)',
                        background: 'transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginRight: 6 }}>{v.variation_ref ?? 'VAR'}</span>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {v.title}
                        </span>
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', marginLeft: 8, flexShrink: 0 }}>{formatAUD(v.amount)}</span>
                    </button>
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
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {/* Pulsing dot — workers are on the clock */}
                        <span
                          className="pulse-dot"
                          style={{ backgroundColor: 'var(--status-green)', color: 'var(--status-green)' }}
                          title="On site"
                          aria-label="On site"
                        />
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{w.name}</span>
                      </div>
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

            {/* ── 7. PROOF TRAIL ──────────────────────────────────────────── */}
            {job && (
              <SectionGroup label="Proof trail">
                <div style={{ ...CARD_STYLE, padding: 0, overflow: 'hidden' }}>
                  <ProofTab jobId={job.id} />
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

      {/* ── VARIATION APPROVE/REJECT MODAL ───────────────────────────────────── */}
      {openVariationId && job && (() => {
        const v = pendingVariations.find((pv) => pv.id === openVariationId)
        if (!v) return null
        return (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.5)' }}
            onClick={() => { setOpenVariationId(null); setVariationActionError(null) }}
          >
            <div onClick={(e) => e.stopPropagation()}>
              <VariationCard
                variation={{
                  id: v.id,
                  title: v.title,
                  description: '',
                  amount: v.amount,
                  status: v.status,
                  job_address: job.address,
                  created_display: new Date(v.created_at).toLocaleDateString('en-AU'),
                  job_id: job.id,
                  variation_ref: v.variation_ref,
                  labour_cost: v.labour_cost,
                  materials_cost: v.materials_cost,
                  submitted_by: v.submitted_by,
                }}
                onApprove={(id) => void handleVariationResolve(id, 'approved')}
                onReject={(id) => void handleVariationResolve(id, 'rejected')}
              />
              {variationActionError && (
                <p style={{ fontSize: 12, color: 'var(--status-red)', marginTop: 8 }}>{variationActionError}</p>
              )}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
