'use client'

// ─── Job Closeout v1 — Wire Existing Reconciliation to the Canonical Snapshot ──
//
// Modeled directly on ActivationModal.tsx (same confirm-with-financial-context
// pattern). This component does NOT calculate reconciliation itself — it only
// assembles the payload POST /api/estimation/reconcile already expects (via
// lib/job-closeout.ts's buildReconciliationEntries) from data the canonical
// job snapshot and the already-loaded actual-cost ledger provide, and calls
// that existing endpoint. All reconciliation math, rate learning, and the
// job.status -> 'complete' transition happen server-side, unchanged.

import { useState } from 'react'
import { buildReconciliationEntries, type JobCostRow } from '@/lib/job-closeout'

export interface CloseJobOverview {
  contract_value: number | null
  actual_cost: number
  current_margin: number | null
  current_margin_pct: number | null
  invoiced: number
  paid: number
  outstanding: number
}

export interface CloseJobResult {
  already_reconciled: boolean
  demo: boolean
}

export interface CloseJobModalProps {
  isOpen: boolean
  onClose: () => void
  onClosed: (result: CloseJobResult) => void
  job: { id: string; address: string }
  quoteId: string | null
  overview: CloseJobOverview
  costs: JobCostRow[]
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

interface LineItemsByCategoryRow {
  category_id: number
  category_total: number
}

export default function CloseJobModal({
  isOpen,
  onClose,
  onClosed,
  job,
  quoteId,
  overview,
  costs,
}: CloseJobModalProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClose() {
    if (!quoteId) {
      setError("This job doesn't have a quote yet — nothing to close out.")
      return
    }

    setLoading(true)
    setError(null)

    try {
      const quoteRes = await fetch(`/api/quotes/${quoteId}`)
      if (!quoteRes.ok) throw new Error("Couldn't load this job's quote — try again.")
      const quoteData = (await quoteRes.json()) as { line_items_by_category?: LineItemsByCategoryRow[] }
      const trades = (quoteData.line_items_by_category ?? []).map((c) => ({
        trade_category_id: c.category_id,
        estimated_cost: c.category_total,
      }))

      if (trades.length === 0) {
        throw new Error('This quote has no priced trades to reconcile.')
      }

      const { entries } = buildReconciliationEntries(trades, costs)

      const res = await fetch('/api/estimation/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: job.id,
          quote_id: quoteId,
          entries,
          final_cost: overview.actual_cost,
          final_margin_pct: overview.current_margin_pct,
        }),
      })

      const data = (await res.json()) as { error?: string; already_reconciled?: boolean; demo?: boolean }
      if (!res.ok) throw new Error(data.error ?? "Couldn't close this job — try again")

      onClosed({
        already_reconciled: data.already_reconciled === true,
        demo: data.demo === true,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't close this job — try again")
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="close-job-modal-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(0,0,0,0.6)' }}
        onClick={loading ? undefined : onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className="relative z-10 w-full max-w-md rounded-xl shadow-xl overflow-hidden"
        style={{ background: 'var(--bg-surface)' }}
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b" style={{ borderColor: 'var(--bg-border)' }}>
          <h2 id="close-job-modal-title" className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            Close job
          </h2>
          <p className="text-sm mt-0.5 truncate" style={{ color: 'var(--text-tertiary)' }}>
            {job.address}
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Contract value</span>
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {overview.contract_value !== null ? formatCurrency(overview.contract_value) : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Actual cost</span>
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {formatCurrency(overview.actual_cost)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Current margin</span>
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {overview.current_margin !== null
                  ? `${formatCurrency(overview.current_margin)}${overview.current_margin_pct !== null ? ` (${overview.current_margin_pct}%)` : ''}`
                  : '—'}
              </span>
            </div>
            <div className="h-px my-1" style={{ background: 'var(--bg-border)' }} />
            <div className="flex items-center justify-between">
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Invoiced</span>
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{formatCurrency(overview.invoiced)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Paid</span>
              <span className="text-sm font-semibold" style={{ color: 'var(--status-green)' }}>{formatCurrency(overview.paid)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Outstanding</span>
              <span className="text-sm font-bold" style={{ color: overview.outstanding > 0 ? 'var(--status-amber)' : 'var(--text-primary)' }}>
                {formatCurrency(overview.outstanding)}
              </span>
            </div>
          </div>

          {/* Warning banner */}
          <div
            className="rounded-md px-3 py-2.5"
            style={{ background: 'rgba(255,152,0,0.1)', border: '0.5px solid var(--bg-border)' }}
          >
            <p className="text-xs" style={{ color: 'var(--status-amber)' }}>
              Closing this job is final — it moves to <strong>complete</strong> and triggers WorkA&apos;s reconciliation,
              comparing the figures above against what this job was estimated to cost and learning from the difference.
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-md px-3 py-2" style={{ background: 'rgba(244,67,54,0.1)', border: '0.5px solid var(--bg-border)' }}>
              <p className="text-xs" style={{ color: 'var(--status-red)' }}>{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
            style={{ color: 'var(--text-secondary)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleClose()}
            disabled={loading}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed shadow-sm"
            style={{ background: 'var(--orange-primary)', color: '#fff' }}
          >
            {loading ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Closing…
              </>
            ) : (
              'Close job'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
