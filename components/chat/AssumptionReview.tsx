'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { AssumptionItem } from '@/lib/assumptions-demo'

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AssumptionReviewProps {
  quoteId: string
  builderId: string
  jobAddress: string
  onComplete: (allResolved: boolean) => void
  onDismiss: () => void
  onViewQuote?: (quoteId: string) => void
}

// ─── Unit options ─────────────────────────────────────────────────────────────

const UNIT_OPTIONS = ['each', 'sqm', 'lm', 'm³', 'hr', 'day', 'week', 'tonne', 'kg', 'lot']

// ─── Format helpers ───────────────────────────────────────────────────────────

function formatCurrency(value: number): string {
  return `$${value.toLocaleString('en-AU')}`
}

// ─── Gate badge config ────────────────────────────────────────────────────────

const gateBadgeConfig = {
  1: {
    dot: '🔴',
    label: 'Gate 1 — Unit missing',
    badgeClass: 'badge-high',
  },
  2: {
    dot: '🟡',
    label: 'Gate 2 — Quantity unverified',
    badgeClass: 'badge-medium',
  },
  3: {
    dot: '⚫',
    label: 'Gate 3 — Invalid quantity',
    badgeClass: 'badge-low',
  },
} as const

// ─── Focusable selector for focus trap ───────────────────────────────────────

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

// ─── Card component for a single assumption ───────────────────────────────────

interface AssumptionCardProps {
  assumption: AssumptionItem
  index: number
  total: number
  onResolve: (
    assumptionId: string,
    resolution: 'accepted' | 'adjusted' | 'excluded',
    adjustedQuantity?: number,
    adjustedUnit?: string
  ) => Promise<void>
  isSubmitting: boolean
  transitionClass: string
}

function AssumptionCard({
  assumption,
  index,
  total,
  onResolve,
  isSubmitting,
  transitionClass,
}: AssumptionCardProps) {
  const gate = assumption.gate
  const config = gateBadgeConfig[gate]

  // Local form state — unit selection for gate 1, quantity input for gate 2 and 3
  const [selectedUnit, setSelectedUnit] = useState<string>(
    assumption.current_unit ?? UNIT_OPTIONS[0]
  )
  const [quantityInput, setQuantityInput] = useState<string>(
    gate === 2 && assumption.current_quantity !== null
      ? String(assumption.current_quantity)
      : ''
  )
  const [showAdjustInput, setShowAdjustInput] = useState(false)
  const [adjustQty, setAdjustQty] = useState<string>(
    assumption.current_quantity !== null ? String(assumption.current_quantity) : ''
  )
  const [adjustUnit, setAdjustUnit] = useState<string>(
    assumption.current_unit ?? UNIT_OPTIONS[0]
  )

  // ── Gate 1: no unit ──────────────────────────────────────────────────────
  if (gate === 1) {
    const handleAccept = () => {
      onResolve(assumption.id, 'accepted', assumption.current_quantity ?? undefined, selectedUnit)
    }

    const handleAdjust = () => {
      if (!showAdjustInput) {
        setShowAdjustInput(true)
        return
      }
      const qty = parseFloat(adjustQty)
      if (isNaN(qty)) return
      onResolve(assumption.id, 'adjusted', qty, adjustUnit)
    }

    const handleExclude = () => {
      onResolve(assumption.id, 'excluded')
    }

    return (
      <div className={`transition-transform duration-300 ease-in-out ${transitionClass}`}>
        <div className="space-y-4">
          {/* Gate badge */}
          <div className="flex items-center gap-2">
            <span aria-hidden="true">{config.dot}</span>
            <span className={config.badgeClass}>{config.label}</span>
          </div>

          {/* Trade + description */}
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
              {assumption.trade_category}
            </p>
            <p className="text-base font-semibold text-slate-900 mt-0.5">
              {assumption.description}
            </p>
          </div>

          {/* Current values */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
            <p className="text-xs font-medium text-amber-700 uppercase tracking-wide mb-1">
              AI extracted
            </p>
            <p className="text-sm text-slate-800">
              <span className="font-semibold">{assumption.current_quantity ?? '—'}</span>
              {' '}
              <span className="text-amber-600 font-medium">[no unit]</span>
              {assumption.current_rate !== null && (
                <span className="text-slate-500"> @ {formatCurrency(assumption.current_rate)}</span>
              )}
            </p>
          </div>

          {/* Unit selector */}
          <div>
            <p className="text-sm font-medium text-slate-700 mb-2">
              What&apos;s the unit for this item?
            </p>
            <select
              value={selectedUnit}
              onChange={(e) => setSelectedUnit(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent bg-white"
            >
              {UNIT_OPTIONS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>

          {/* Adjust input (shown when adjust is clicked) */}
          {showAdjustInput && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-700">Adjust quantity:</p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={adjustQty}
                  onChange={(e) => setAdjustQty(e.target.value)}
                  placeholder="Quantity"
                  min="0"
                  step="any"
                  className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent"
                />
                <select
                  value={adjustUnit}
                  onChange={(e) => setAdjustUnit(e.target.value)}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent bg-white"
                >
                  {UNIT_OPTIONS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="space-y-2 pt-1">
            <button
              onClick={handleAccept}
              disabled={isSubmitting}
              className="w-full btn-primary py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Accept as-is
            </button>
            <button
              onClick={handleAdjust}
              disabled={isSubmitting}
              className="w-full btn-secondary py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {showAdjustInput ? 'Confirm adjustment' : 'Adjust quantity'}
            </button>
            <button
              onClick={handleExclude}
              disabled={isSubmitting}
              className="w-full py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Exclude from quote
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Gate 2: no dimensions ─────────────────────────────────────────────────
  if (gate === 2) {
    const handleConfirm = () => {
      const qty = parseFloat(quantityInput)
      if (isNaN(qty)) return
      onResolve(assumption.id, 'accepted', qty, assumption.current_unit ?? undefined)
    }

    const handleAdjust = () => {
      if (!showAdjustInput) {
        setShowAdjustInput(true)
        return
      }
      const qty = parseFloat(adjustQty)
      if (isNaN(qty)) return
      onResolve(assumption.id, 'adjusted', qty, adjustUnit)
    }

    const handleExclude = () => {
      onResolve(assumption.id, 'excluded')
    }

    return (
      <div className={`transition-transform duration-300 ease-in-out ${transitionClass}`}>
        <div className="space-y-4">
          {/* Gate badge */}
          <div className="flex items-center gap-2">
            <span aria-hidden="true">{config.dot}</span>
            <span className={config.badgeClass}>{config.label}</span>
          </div>

          {/* Trade + description */}
          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
              {assumption.trade_category}
            </p>
            <p className="text-base font-semibold text-slate-900 mt-0.5">
              {assumption.description}
            </p>
          </div>

          {/* Current values */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
            <p className="text-xs font-medium text-amber-700 uppercase tracking-wide mb-1">
              AI extracted
            </p>
            <p className="text-sm text-slate-800">
              <span className="font-semibold">
                {assumption.current_quantity ?? '—'}{' '}
                {assumption.current_unit ?? ''}
              </span>
              {assumption.current_rate !== null && (
                <span className="text-slate-500"> @ {formatCurrency(assumption.current_rate)}</span>
              )}
            </p>
            <p className="text-xs text-amber-600 mt-1">No measurements found in plans</p>
          </div>

          {/* Quantity input */}
          <div>
            <p className="text-sm font-medium text-slate-700 mb-2">
              Can you confirm this quantity?
            </p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={quantityInput}
                onChange={(e) => setQuantityInput(e.target.value)}
                min="0"
                step="any"
                className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent"
              />
              {assumption.current_unit && (
                <span className="text-sm text-slate-600 font-medium px-2">
                  {assumption.current_unit}
                </span>
              )}
            </div>
          </div>

          {/* Adjust input */}
          {showAdjustInput && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-700">Adjusted values:</p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={adjustQty}
                  onChange={(e) => setAdjustQty(e.target.value)}
                  placeholder="Quantity"
                  min="0"
                  step="any"
                  className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent"
                />
                <select
                  value={adjustUnit}
                  onChange={(e) => setAdjustUnit(e.target.value)}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent bg-white"
                >
                  {UNIT_OPTIONS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="space-y-2 pt-1">
            <button
              onClick={handleConfirm}
              disabled={isSubmitting || !quantityInput}
              className="w-full btn-primary py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Confirm quantity
            </button>
            <button
              onClick={handleAdjust}
              disabled={isSubmitting}
              className="w-full btn-secondary py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {showAdjustInput ? 'Confirm adjustment' : 'Adjust quantity'}
            </button>
            <button
              onClick={handleExclude}
              disabled={isSubmitting}
              className="w-full py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Exclude from quote
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Gate 3: zero/negative quantity ────────────────────────────────────────
  const handleAddToQuote = () => {
    const qty = parseFloat(quantityInput)
    if (isNaN(qty) || qty <= 0) return
    onResolve(assumption.id, 'adjusted', qty, assumption.current_unit ?? undefined)
  }

  const handleKeepExcluded = () => {
    onResolve(assumption.id, 'excluded')
  }

  return (
    <div className={`transition-transform duration-300 ease-in-out ${transitionClass}`}>
      <div className="space-y-4">
        {/* Gate badge */}
        <div className="flex items-center gap-2">
          <span aria-hidden="true">{config.dot}</span>
          <span className={config.badgeClass}>{config.label}</span>
        </div>

        {/* Trade + description */}
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
            {assumption.trade_category}
          </p>
          <p className="text-base font-semibold text-slate-900 mt-0.5">
            {assumption.description}
          </p>
        </div>

        {/* Current values */}
        <div className="bg-slate-100 border border-slate-200 rounded-lg px-3 py-2.5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">
            AI extracted
          </p>
          <p className="text-sm text-slate-800">
            <span className="font-semibold">
              {assumption.current_quantity} {assumption.current_unit}
            </span>
            {assumption.current_rate !== null && (
              <span className="text-slate-500"> @ {formatCurrency(assumption.current_rate)}/{assumption.current_unit}</span>
            )}
          </p>
          <p className="text-xs text-slate-500 mt-1">Zero quantity — excluded from quote</p>
        </div>

        {/* Quantity input */}
        <div>
          <p className="text-sm font-medium text-slate-700 mb-2">
            Enter the correct quantity:
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={quantityInput}
              onChange={(e) => setQuantityInput(e.target.value)}
              placeholder="Quantity"
              min="0.01"
              step="any"
              className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent"
            />
            {assumption.current_unit && (
              <span className="text-sm text-slate-600 font-medium px-2">
                {assumption.current_unit}
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="space-y-2 pt-1">
          {quantityInput && parseFloat(quantityInput) > 0 && (
            <button
              onClick={handleAddToQuote}
              disabled={isSubmitting}
              className="w-full btn-primary py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add to quote
            </button>
          )}
          <button
            onClick={handleKeepExcluded}
            disabled={isSubmitting}
            className="w-full py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Keep excluded
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Completion screen ────────────────────────────────────────────────────────

interface CompletionScreenProps {
  onViewQuote: () => void
}

function CompletionScreen({ onViewQuote }: CompletionScreenProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center space-y-4">
      <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
        <svg
          className="w-8 h-8 text-green-600"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <div>
        <h3 className="text-lg font-semibold text-slate-900">All done</h3>
        <p className="text-sm text-slate-600 mt-1">Your quote is ready to review.</p>
      </div>
      <button
        type="button"
        className="btn-primary px-6 py-2.5 text-sm"
        onClick={onViewQuote}
      >
        View draft quote
      </button>
    </div>
  )
}

// ─── Inner component (rendered inside portal) ─────────────────────────────────

function AssumptionReviewInner({
  quoteId,
  builderId,
  jobAddress,
  onComplete,
  onDismiss,
  onViewQuote,
}: AssumptionReviewProps) {
  const [assumptions, setAssumptions] = useState<AssumptionItem[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isComplete, setIsComplete] = useState(false)
  const [visible, setVisible] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [transitionClass, setTransitionClass] = useState('translate-x-0')

  const panelRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  // Animate in
  useEffect(() => {
    setMounted(true)
    const id = setTimeout(() => setVisible(true), 10)
    return () => clearTimeout(id)
  }, [])

  // Focus close button when visible
  useEffect(() => {
    if (visible) {
      closeButtonRef.current?.focus()
    }
  }, [visible])

  // Escape key + focus trap
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleDismiss()
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
        ).filter((el) => !el.hasAttribute('disabled'))
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  // Fetch assumptions on mount
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/assumptions/${quoteId}`)
        const data = await res.json() as { assumptions: AssumptionItem[] }
        const unresolved = data.assumptions.filter((a) => a.resolution_type === 'unresolved')
        setAssumptions(unresolved)
      } catch {
        setAssumptions([])
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [quoteId])

  const handleDismiss = useCallback(() => {
    setVisible(false)
    setTimeout(() => {
      onDismiss()
    }, 220)
  }, [onDismiss])

  const handleResolve = useCallback(
    async (
      assumptionId: string,
      resolution: 'accepted' | 'adjusted' | 'excluded',
      adjustedQuantity?: number,
      adjustedUnit?: string
    ) => {
      setIsSubmitting(true)
      try {
        const res = await fetch(`/api/assumptions/${quoteId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assumption_id: assumptionId,
            resolution,
            adjusted_quantity: adjustedQuantity,
            adjusted_unit: adjustedUnit,
            builder_id: builderId,
          }),
        })
        const data = await res.json() as { all_resolved: boolean }

        // Animate card out (slide left), then advance
        setTransitionClass('-translate-x-full opacity-0')
        await new Promise<void>((resolve) => setTimeout(resolve, 250))

        const nextIndex = currentIndex + 1
        const isLast = nextIndex >= assumptions.length

        if (isLast || data.all_resolved) {
          setIsComplete(true)
          setTimeout(() => onComplete(true), 400)
        } else {
          setCurrentIndex(nextIndex)
          // Slide in from right
          setTransitionClass('translate-x-full opacity-0')
          await new Promise<void>((resolve) => setTimeout(resolve, 50))
          setTransitionClass('translate-x-0 opacity-100')
        }
      } catch {
        // On error, stay on current card
      } finally {
        setIsSubmitting(false)
      }
    },
    [quoteId, builderId, currentIndex, assumptions.length, onComplete]
  )

  if (!mounted) return null

  const current = assumptions[currentIndex]
  const total = assumptions.length
  const displayIndex = currentIndex + 1

  return (
    <div
      className={[
        'fixed inset-0 z-50 flex items-end sm:items-center justify-center',
        'transition-opacity duration-200',
        visible ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
      aria-modal="true"
      role="dialog"
      aria-label={`Review assumptions for ${jobAddress}`}
    >
      {/* Panel */}
      <div
        ref={panelRef}
        className={[
          'relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden',
          'transition-transform duration-220 ease-out',
          visible ? 'translate-y-0 sm:scale-100' : 'translate-y-full sm:scale-95',
        ].join(' ')}
        style={{ transitionDuration: '220ms', maxHeight: '90vh', overflowY: 'auto' }}
      >
        {/* ── Header ──────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-slate-100 sticky top-0 bg-white z-10">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-slate-900">Review assumptions</h2>
            {!isLoading && !isComplete && total > 0 && (
              <span className="text-xs text-slate-400 font-medium">
                {displayIndex} of {total}
              </span>
            )}
          </div>
          <button
            ref={closeButtonRef}
            onClick={handleDismiss}
            className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            aria-label="Dismiss review"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M1 1l12 12M13 1L1 13"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* ── Progress dots ────────────────────────────────────────── */}
        {!isLoading && !isComplete && total > 1 && (
          <div className="flex items-center justify-center gap-1.5 pt-3 pb-1">
            {assumptions.map((_, i) => (
              <span
                key={i}
                className={[
                  'w-2 h-2 rounded-full transition-colors duration-200',
                  i === currentIndex
                    ? 'bg-brand-500'
                    : i < currentIndex
                    ? 'bg-brand-200'
                    : 'bg-slate-200',
                ].join(' ')}
                aria-hidden="true"
              />
            ))}
          </div>
        )}

        {/* ── Body ────────────────────────────────────────────────── */}
        <div className="px-5 py-4">
          {isLoading && (
            <div className="flex items-center justify-center py-12">
              <span className="text-sm text-slate-400">Loading assumptions…</span>
            </div>
          )}

          {!isLoading && isComplete && (
            <CompletionScreen
              onViewQuote={() => {
                setVisible(false)
                setTimeout(() => {
                  onComplete(true)
                  onViewQuote?.(quoteId)
                }, 220)
              }}
            />
          )}

          {!isLoading && !isComplete && total === 0 && (
            <div className="py-8 text-center">
              <p className="text-sm text-slate-500">No unresolved assumptions found.</p>
            </div>
          )}

          {!isLoading && !isComplete && current && (
            <AssumptionCard
              key={current.id}
              assumption={current}
              index={currentIndex}
              total={total}
              onResolve={handleResolve}
              isSubmitting={isSubmitting}
              transitionClass={transitionClass}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Portal wrapper ───────────────────────────────────────────────────────────

export default function AssumptionReview(props: AssumptionReviewProps) {
  const [portalTarget, setPortalTarget] = useState<Element | null>(null)

  useEffect(() => {
    setPortalTarget(document.body)
  }, [])

  if (!portalTarget) return null
  return createPortal(<AssumptionReviewInner {...props} />, portalTarget)
}
