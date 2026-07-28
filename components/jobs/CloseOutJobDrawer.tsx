'use client'

import { useEffect, useRef, useState } from 'react'
import { tradeCategoryName } from '@/lib/trade-taxonomy'

interface TradeRow {
  trade_category_id: number
  estimated_cost: number
}

interface CloseOutJobDrawerProps {
  open: boolean
  jobId: string
  onClose: () => void
  onClosed: () => void
}

function formatAud(amount: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(amount)
}

// The simplest workflow the pricing-intelligence design allows: no per-line-
// item accounting (a builder will not do a 30-minute reconciliation), just
// one actual-cost figure per trade already on the quote. Wires directly into
// the EXISTING POST /api/estimation/reconcile — nothing new on the backend
// beyond what the investigation confirmed was already built and unwired.
export default function CloseOutJobDrawer({ open, jobId, onClose, onClosed }: CloseOutJobDrawerProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [quoteId, setQuoteId] = useState<string | null>(null)
  const [trades, setTrades] = useState<TradeRow[] | null>(null)
  const [actuals, setActuals] = useState<Record<number, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      setTrades(null)
      setActuals({})
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    fetch(`/api/jobs/${jobId}/snapshot`)
      .then((res) => res.json())
      .then((data) => {
        const qId = data.snapshot?.quote?.id ?? null
        setQuoteId(qId)
        if (!qId) {
          setError("This job doesn't have a quote yet — nothing to close out.")
          setLoading(false)
          return
        }
        return fetch(`/api/quotes/${qId}`)
          .then((res) => res.json())
          .then((quoteData) => {
            const rows: TradeRow[] = (quoteData.line_items_by_category ?? []).map((c: { category_id: number; category_total: number }) => ({
              trade_category_id: c.category_id,
              estimated_cost: c.category_total,
            }))
            setTrades(rows)
            setLoading(false)
            setTimeout(() => firstFieldRef.current?.focus(), 100)
          })
      })
      .catch(() => {
        setError("Couldn't load this job's quote — try again.")
        setLoading(false)
      })
  }, [open, jobId])

  const canSubmit = trades !== null && trades.length > 0 && !submitting

  async function handleSubmit() {
    if (!trades || !quoteId) return
    setSubmitting(true)
    setError(null)
    try {
      const entries = trades.map((t) => ({
        trade_category_id: t.trade_category_id,
        estimated_cost: t.estimated_cost,
        actual_cost: actuals[t.trade_category_id]?.trim() ? Number(actuals[t.trade_category_id]) : null,
      }))
      const res = await fetch('/api/estimation/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId, quote_id: quoteId, entries }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Couldn't close out this job — try again")
      onClosed()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't close out this job — try again")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 transition-opacity"
        style={{ background: 'rgba(0,0,0,0.4)', opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none', transitionDuration: open ? '400ms' : '250ms' }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Close out job"
        className="fixed top-0 right-0 h-full z-50 flex flex-col w-full sm:w-[440px]"
        style={{
          background: 'var(--bg-surface)',
          borderLeft: '0.5px solid var(--bg-border)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: `transform ${open ? '400ms cubic-bezier(.2,.8,.2,1)' : '250ms cubic-bezier(.4,0,1,1)'}`,
        }}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '0.5px solid var(--bg-border)' }}>
          <div>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Close out job</h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>What did each trade actually cost? WorkA learns from the difference.</p>
          </div>
          <button onClick={onClose} className="btn-ghost w-8 h-8 flex items-center justify-center rounded-[6px]" aria-label="Close">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-3">
          {loading && (
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => <div key={i} className="h-14 rounded-[6px] animate-pulse" style={{ background: 'var(--bg-elevated)' }} />)}
            </div>
          )}

          {!loading && trades && trades.map((t, idx) => (
            <div key={t.trade_category_id} className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{tradeCategoryName(t.trade_category_id)}</p>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Estimated: {formatAud(t.estimated_cost)}</p>
              </div>
              <input
                ref={idx === 0 ? firstFieldRef : undefined}
                type="number"
                min="0"
                className="input px-3 py-2 w-32 text-sm"
                placeholder="Actual $"
                value={actuals[t.trade_category_id] ?? ''}
                onChange={(e) => setActuals((prev) => ({ ...prev, [t.trade_category_id]: e.target.value }))}
              />
            </div>
          ))}

          {!loading && trades && trades.length === 0 && (
            <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>This quote has no priced trades to reconcile.</p>
          )}

          {error && (
            <div className="text-sm px-3 py-2.5 rounded-[6px]" style={{ background: 'rgba(244,67,54,0.1)', color: 'var(--status-red)' }}>{error}</div>
          )}

          <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>Leave a trade blank if you don't know yet — WorkA only learns from the trades you fill in.</p>
        </div>

        <div className="px-5 py-4 flex gap-2" style={{ borderTop: '0.5px solid var(--bg-border)' }}>
          <button className="btn-secondary flex-1 py-2" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary flex-1 py-2"
            disabled={!canSubmit}
            style={{ opacity: !canSubmit ? 0.5 : 1 }}
            onClick={handleSubmit}
          >
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </div>
    </>
  )
}
