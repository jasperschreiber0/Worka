'use client'

import { useState } from 'react'
import { generateInvoiceSchedule, type DemoMilestone, type DemoInvoiceScheduleItem, type DemoProofEvent } from '@/lib/activation-demo'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActivationResult {
  job: { id: string; address: string; status: 'active' }
  quote: { id: string; status: 'approved'; total_cost: number }
  milestones: DemoMilestone[]
  invoice_schedule: DemoInvoiceScheduleItem[]
  first_proof_event: DemoProofEvent
  activated_at: string
}

export interface ActivationModalProps {
  isOpen: boolean
  onClose: () => void
  onActivated: (result: ActivationResult) => void
  job: { id: string; address: string }
  quote: { id: string; total_cost: number; version: number }
  builderId: string
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

// ─── Component ────────────────────────────────────────────────────────────────

export default function ActivationModal({
  isOpen,
  onClose,
  onActivated,
  job,
  quote,
  builderId,
}: ActivationModalProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Pre-compute invoice schedule amounts from quote total
  const scheduleItems = generateInvoiceSchedule(job.id, quote.total_cost)

  async function handleActivate() {
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/jobs/${job.id}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builder_id: builderId,
          quote_id: quote.id,
        }),
      })

      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(data.error ?? 'Activation failed')
      }

      const result = await res.json() as ActivationResult
      onActivated(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation failed — please try again.')
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
      aria-labelledby="activation-modal-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-slate-900/50"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-md bg-white rounded-xl shadow-xl overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-slate-100">
          <h2 id="activation-modal-title" className="text-base font-semibold text-slate-900">
            Activate job
          </h2>
          <p className="text-sm text-slate-500 mt-0.5 truncate">{job.address}</p>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          {/* Contract value */}
          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
              Contract value
            </p>
            <p className="text-2xl font-bold text-slate-900">{formatCurrency(quote.total_cost)}</p>
          </div>

          {/* What WorkA will create */}
          <div className="space-y-4">
            <p className="text-sm font-semibold text-slate-700">WorkA will create:</p>

            {/* Milestones */}
            <div className="flex items-start gap-3">
              <span
                className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-green-100 flex items-center justify-center"
                aria-hidden="true"
              >
                <svg className="w-3 h-3 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </span>
              <div>
                <p className="text-sm font-medium text-slate-800">8 project milestones</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  Contract signing through to final inspection — spread over 17 weeks
                </p>
              </div>
            </div>

            {/* Invoice schedule */}
            <div className="flex items-start gap-3">
              <span
                className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-green-100 flex items-center justify-center"
                aria-hidden="true"
              >
                <svg className="w-3 h-3 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </span>
              <div>
                <p className="text-sm font-medium text-slate-800">5-stage invoice schedule</p>
                <div className="mt-1.5 space-y-1">
                  {scheduleItems.map((item) => (
                    <div key={item.id} className="flex items-center justify-between">
                      <span className="text-xs text-slate-500">{item.label} ({item.percentage}%)</span>
                      <span className="text-xs font-medium text-slate-700">{formatCurrency(item.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Proof feed */}
            <div className="flex items-start gap-3">
              <span
                className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-green-100 flex items-center justify-center"
                aria-hidden="true"
              >
                <svg className="w-3 h-3 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </span>
              <div>
                <p className="text-sm font-medium text-slate-800">Proof feed starts now</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  Every variation, approval, and communication is logged automatically.
                </p>
              </div>
            </div>
          </div>

          {/* Warning banner */}
          <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2.5">
            <p className="text-xs text-amber-800">
              Activation is irreversible — the job moves to <strong>active</strong> and cannot go back to quoted.
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2">
              <p className="text-xs text-red-700">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleActivate()}
            disabled={loading}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-brand-500 text-white text-sm font-semibold hover:bg-brand-600 transition-colors disabled:opacity-60 disabled:cursor-not-allowed shadow-sm"
          >
            {loading ? (
              <>
                <svg
                  className="w-4 h-4 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Activating…
              </>
            ) : (
              <>
                Activate job
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                </svg>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
