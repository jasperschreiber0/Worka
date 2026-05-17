'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { DemoQuote, DemoQuoteLineItem } from '@/lib/quote-demo'
import SendQuoteModal from './SendQuoteModal'

// ─── Props ────────────────────────────────────────────────────────────────────

export interface QuoteViewProps {
  quoteId: string
  builderId: string
  onClose: () => void
  onSend: (quoteId: string) => void
  onRevise: (quoteId: string) => void
  onExportPdf: (quoteId: string) => void
}

// ─── API response types ───────────────────────────────────────────────────────

interface LineItemsByCategory {
  category_id: number
  category_name: string
  items: DemoQuoteLineItem[]
  category_total: number
  has_assumptions: boolean
  min_confidence: number
}

interface QuoteSummary {
  total_cost: number
  margin_pct: number
  confidence_score: number
  unresolved_count: number
  assumption_count: number
  can_send: boolean
}

interface QuoteApiResponse {
  quote: DemoQuote
  line_items_by_category: LineItemsByCategory[]
  summary: QuoteSummary
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function formatCurrency(value: number): string {
  return `$${value.toLocaleString('en-AU')}`
}

function formatQuantity(qty: number | null): string {
  if (qty === null) return '[?]'
  return String(qty)
}

function formatRate(rate: number | null): string {
  if (rate === null) return '[?]'
  return `$${rate.toLocaleString('en-AU')}`
}

function formatTotal(total: number | null): string {
  if (total === null) return '[?]'
  return formatCurrency(total)
}

// ─── Confidence indicator ─────────────────────────────────────────────────────

interface ConfidenceIndicatorProps {
  confidence: number
  isAssumption: boolean
  assumptionStatus: DemoQuoteLineItem['assumption_status']
}

function ConfidenceIndicator({ confidence, isAssumption, assumptionStatus }: ConfidenceIndicatorProps) {
  if (isAssumption && assumptionStatus === 'unresolved') {
    return (
      <span className="flex items-center gap-1 flex-shrink-0">
        <span className="w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0" aria-hidden="true" />
        <span className="text-xs font-medium text-red-600 whitespace-nowrap">Needs input</span>
      </span>
    )
  }

  if (assumptionStatus === 'excluded') {
    return (
      <span className="flex items-center gap-1 flex-shrink-0">
        <span className="w-2.5 h-2.5 rounded-full bg-slate-400 flex-shrink-0" aria-hidden="true" />
        <span className="text-xs font-medium text-slate-400 whitespace-nowrap">Excluded</span>
      </span>
    )
  }

  if (confidence >= 85) {
    return (
      <span className="flex items-center gap-1 flex-shrink-0" title={`Confidence: ${confidence}%`}>
        <span className="w-2.5 h-2.5 rounded-full bg-green-500 flex-shrink-0" aria-hidden="true" />
        <span className="text-xs font-medium text-green-600">{confidence}%</span>
      </span>
    )
  }

  if (confidence >= 60) {
    return (
      <span className="flex items-center gap-1 flex-shrink-0" title={`Confidence: ${confidence}%`}>
        <span className="w-2.5 h-2.5 rounded-full bg-amber-400 flex-shrink-0" aria-hidden="true" />
        <span className="text-xs font-medium text-amber-500">{confidence}%</span>
      </span>
    )
  }

  return (
    <span className="flex items-center gap-1 flex-shrink-0" title={`Confidence: ${confidence}%`}>
      <span className="w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0" aria-hidden="true" />
      <span className="text-xs font-medium text-red-600">{confidence}%</span>
    </span>
  )
}

// ─── Overall confidence badge ─────────────────────────────────────────────────

function OverallConfidenceBadge({ score }: { score: number }) {
  if (score >= 80) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-100 text-green-700 text-sm font-semibold">
        <span className="w-2 h-2 rounded-full bg-green-500" aria-hidden="true" />
        {score}%
      </span>
    )
  }
  if (score >= 60) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 text-sm font-semibold">
        <span className="w-2 h-2 rounded-full bg-amber-400" aria-hidden="true" />
        {score}%
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-100 text-red-700 text-sm font-semibold">
      <span className="w-2 h-2 rounded-full bg-red-500" aria-hidden="true" />
      {score}%
    </span>
  )
}

// ─── Skeleton row ─────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 border-b border-slate-100 last:border-0">
      <div className="flex-1 animate-pulse bg-slate-200 rounded h-4" />
      <div className="w-16 animate-pulse bg-slate-200 rounded h-4" />
      <div className="w-16 animate-pulse bg-slate-200 rounded h-4" />
      <div className="w-16 animate-pulse bg-slate-200 rounded h-4" />
      <div className="w-16 animate-pulse bg-slate-200 rounded h-4" />
    </div>
  )
}

function SkeletonCategory() {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 animate-pulse bg-slate-200 rounded" />
          <div className="w-40 h-5 animate-pulse bg-slate-200 rounded" />
        </div>
        <div className="w-20 h-5 animate-pulse bg-slate-200 rounded" />
      </div>
      <div className="border border-slate-200 rounded-lg mx-4 overflow-hidden">
        <SkeletonRow />
        <SkeletonRow />
      </div>
    </div>
  )
}

// ─── Line item row ────────────────────────────────────────────────────────────

interface LineItemRowProps {
  item: DemoQuoteLineItem
}

function LineItemRow({ item }: LineItemRowProps) {
  const isExcluded = item.assumption_status === 'excluded'
  const isUnresolved = item.is_assumption && item.assumption_status === 'unresolved'

  const rowClass = [
    'flex items-start gap-2 px-3 py-2.5 border-b border-slate-100 last:border-0',
    isUnresolved ? 'bg-red-50' : '',
    isExcluded ? 'opacity-60' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const textClass = isExcluded ? 'line-through text-slate-400' : 'text-slate-800'

  return (
    <div className={rowClass} role="row">
      {/* Description — takes most space */}
      <div className="flex-1 min-w-0">
        <span className={`text-sm leading-tight block truncate ${textClass}`}>
          {item.description}
        </span>
        {item.dimensions_string && !isExcluded && (
          <span className="text-xs text-slate-400 block truncate mt-0.5">
            {item.dimensions_string}
          </span>
        )}
      </div>

      {/* Qty + unit */}
      <div className="flex-shrink-0 text-right w-16 sm:w-20">
        <span className={`text-sm tabular-nums ${isExcluded ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
          {formatQuantity(item.quantity)}
          {item.unit ? (
            <span className="text-xs text-slate-500 ml-0.5">{item.unit}</span>
          ) : (
            <span className="text-xs text-red-500 ml-0.5">[?]</span>
          )}
        </span>
      </div>

      {/* Rate */}
      <div className="flex-shrink-0 text-right w-16 sm:w-20 hidden sm:block">
        <span className={`text-sm tabular-nums ${isExcluded ? 'text-slate-400 line-through' : 'text-slate-600'}`}>
          {formatRate(item.rate)}
        </span>
      </div>

      {/* Total */}
      <div className="flex-shrink-0 text-right w-20 sm:w-24">
        <span className={`text-sm font-medium tabular-nums ${isExcluded ? 'text-slate-400 line-through' : 'text-slate-900'}`}>
          {isExcluded ? 'Excluded' : formatTotal(item.total)}
        </span>
      </div>

      {/* Confidence indicator */}
      <div className="flex-shrink-0 w-20 sm:w-24 flex justify-end">
        <ConfidenceIndicator
          confidence={item.confidence}
          isAssumption={item.is_assumption}
          assumptionStatus={item.assumption_status}
        />
      </div>
    </div>
  )
}

// ─── Category section ─────────────────────────────────────────────────────────

interface CategorySectionProps {
  group: LineItemsByCategory
  isExpanded: boolean
  onToggle: () => void
}

function CategorySection({ group, isExpanded, onToggle }: CategorySectionProps) {
  const hasUnresolved = group.items.some(
    (i) => i.is_assumption && i.assumption_status === 'unresolved'
  )

  return (
    <div className="mb-2">
      {/* Category header — clickable */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors text-left rounded-lg"
        aria-expanded={isExpanded}
        aria-controls={`category-${group.category_id}`}
      >
        <div className="flex items-center gap-2">
          {/* Chevron */}
          <svg
            className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${isExpanded ? 'rotate-0' : '-rotate-90'}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
          <span className="text-sm font-semibold text-slate-800 uppercase tracking-wide">
            {group.category_name}
          </span>
          {hasUnresolved && (
            <span
              className="text-amber-500 text-sm leading-none ml-1"
              aria-label="Has unresolved items"
              title="Has unresolved assumptions"
            >
              ⚠
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-slate-900 tabular-nums">
            {formatCurrency(group.category_total)}
          </span>
        </div>
      </button>

      {/* Collapsible items */}
      <div
        id={`category-${group.category_id}`}
        className="overflow-hidden transition-all duration-200 ease-in-out"
        style={{
          maxHeight: isExpanded ? '9999px' : '0px',
        }}
      >
        <div className="mx-4 mb-2 border border-slate-200 rounded-lg overflow-hidden">
          {/* Column headers — hidden on mobile, visible on sm+ */}
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-slate-50 border-b border-slate-200">
            <div className="flex-1 text-xs font-medium text-slate-500 uppercase tracking-wide">
              Description
            </div>
            <div className="flex-shrink-0 w-20 text-right text-xs font-medium text-slate-500 uppercase tracking-wide">
              Qty
            </div>
            <div className="flex-shrink-0 w-20 text-right text-xs font-medium text-slate-500 uppercase tracking-wide">
              Rate
            </div>
            <div className="flex-shrink-0 w-24 text-right text-xs font-medium text-slate-500 uppercase tracking-wide">
              Total
            </div>
            <div className="flex-shrink-0 w-24 text-right text-xs font-medium text-slate-500 uppercase tracking-wide">
              Confidence
            </div>
          </div>
          {group.items.map((item) => (
            <LineItemRow key={item.id} item={item} />
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Summary card ─────────────────────────────────────────────────────────────

interface SummaryCardProps {
  summary: QuoteSummary
}

function SummaryCard({ summary }: SummaryCardProps) {
  const confidenceLabel =
    summary.confidence_score >= 80
      ? 'High confidence'
      : summary.confidence_score >= 60
      ? 'Medium confidence — review amber items'
      : 'Low confidence — red items need input'

  return (
    <div className="mx-4 mb-4 border border-slate-200 rounded-xl overflow-hidden shadow-sm">
      <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Summary</h3>
      </div>
      <div className="divide-y divide-slate-100">
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-sm text-slate-600">Total cost</span>
          <span className="text-sm font-bold text-slate-900 tabular-nums">
            {formatCurrency(summary.total_cost)}
          </span>
        </div>
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-sm text-slate-600">Margin</span>
          <span className="text-sm font-semibold text-slate-900">{summary.margin_pct}%</span>
        </div>
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-sm text-slate-600">Confidence</span>
          <div className="flex items-center gap-2">
            <OverallConfidenceBadge score={summary.confidence_score} />
            <span className="text-xs text-slate-500 hidden sm:inline">{confidenceLabel}</span>
          </div>
        </div>
        {summary.unresolved_count > 0 && (
          <div className="flex items-center gap-2 px-4 py-2.5 bg-red-50">
            <svg
              className="w-4 h-4 text-red-500 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
              />
            </svg>
            <span className="text-sm font-medium text-red-700">
              {summary.unresolved_count} item{summary.unresolved_count !== 1 ? 's' : ''} need
              {summary.unresolved_count === 1 ? 's' : ''} your input before sending
            </span>
          </div>
        )}
        {summary.unresolved_count === 0 && summary.assumption_count > 0 && (
          <div className="flex items-center gap-2 px-4 py-2.5 bg-green-50">
            <svg
              className="w-4 h-4 text-green-500 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-sm font-medium text-green-700">
              All assumptions resolved — quote is ready to send
            </span>
          </div>
        )}
        {summary.unresolved_count === 0 && summary.assumption_count === 0 && (
          <div className="flex items-center gap-2 px-4 py-2.5 bg-green-50">
            <svg
              className="w-4 h-4 text-green-500 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-sm font-medium text-green-700">
              Quote is ready to send
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Action bar ───────────────────────────────────────────────────────────────

interface ActionBarProps {
  quoteId: string
  summary: QuoteSummary
  onSend: (quoteId: string) => void
  onRevise: (quoteId: string) => void
  onExportPdf: (quoteId: string) => void
}

function ActionBar({ quoteId, summary, onSend, onRevise, onExportPdf }: ActionBarProps) {
  return (
    <div className="flex-shrink-0 border-t border-slate-200 bg-white px-4 py-3">
      {!summary.can_send && (
        <p className="text-sm text-red-600 font-medium mb-2 flex items-center gap-1.5">
          <svg
            className="w-4 h-4 flex-shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
            />
          </svg>
          Send blocked — resolve {summary.unresolved_count} item
          {summary.unresolved_count !== 1 ? 's' : ''} to enable sending
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSend(quoteId)}
          disabled={!summary.can_send}
          title={
            summary.can_send
              ? 'Send quote to client'
              : `Resolve ${summary.unresolved_count} item${summary.unresolved_count !== 1 ? 's' : ''} to enable sending`
          }
          className="btn-primary px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed flex-1 sm:flex-none"
        >
          Send to client
        </button>
        <button
          type="button"
          onClick={() => onExportPdf(quoteId)}
          className="btn-secondary px-4 py-2 text-sm flex-1 sm:flex-none"
        >
          Export PDF
        </button>
        <button
          type="button"
          onClick={() => onRevise(quoteId)}
          className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors flex-1 sm:flex-none"
        >
          Revise
        </button>
      </div>
    </div>
  )
}

// ─── Focusable selector for focus trap ───────────────────────────────────────

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

// ─── Inner component (rendered inside portal) ─────────────────────────────────

function QuoteViewInner({
  quoteId,
  builderId,
  onClose,
  onSend,
  onRevise,
  onExportPdf,
}: QuoteViewProps) {
  const [data, setData] = useState<QuoteApiResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [sendModalOpen, setSendModalOpen] = useState(false)
  const [sentAt, setSentAt] = useState<string | null>(null)

  // Set of expanded category IDs — all start expanded
  const [expandedCategories, setExpandedCategories] = useState<Set<number>>(new Set())

  const overlayRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

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
        handleClose()
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

  // Fetch quote data
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/quotes/${quoteId}`)
        if (!res.ok) {
          setError('Failed to load quote. Please try again.')
          return
        }
        const json = await res.json() as QuoteApiResponse
        setData(json)
        // Expand all categories by default
        const allIds = new Set(json.line_items_by_category.map((g) => g.category_id))
        setExpandedCategories(allIds)
      } catch {
        setError('Something went wrong loading the quote.')
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [quoteId])

  const handleClose = useCallback(() => {
    setSendModalOpen(false)
    setVisible(false)
    setTimeout(() => onClose(), 220)
  }, [onClose])

  // Open SendQuoteModal instead of calling onSend directly
  const handleSendClick = useCallback((_qId: string) => {
    setSendModalOpen(true)
  }, [])

  // Called by SendQuoteModal on successful send
  const handleSent = useCallback((at: string) => {
    setSendModalOpen(false)
    setSentAt(at)
    onSend(quoteId)
  }, [quoteId, onSend])

  // Export PDF — open in new tab
  const handleExportPdfClick = useCallback((_qId: string) => {
    window.open(`/api/quotes/${quoteId}/export-pdf`, '_blank')
    onExportPdf(quoteId)
  }, [quoteId, onExportPdf])

  // Revise — POST then close and notify parent
  const handleReviseClick = useCallback(async (_qId: string) => {
    try {
      await fetch(`/api/quotes/${quoteId}/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builder_id: builderId }),
      })
    } catch {
      // Best-effort — parent will handle message regardless
    }
    onRevise(quoteId)
    handleClose()
  }, [quoteId, builderId, onRevise, handleClose])

  const toggleCategory = useCallback((categoryId: number) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(categoryId)) {
        next.delete(categoryId)
      } else {
        next.add(categoryId)
      }
      return next
    })
  }, [])

  if (!mounted) return null

  return (
    <div
      ref={overlayRef}
      className={[
        'fixed inset-0 z-50 flex flex-col',
        'transition-opacity duration-200',
        visible ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
      style={{ backgroundColor: 'rgba(15, 23, 42, 0.6)' }}
      aria-modal="true"
      role="dialog"
      aria-label={`Draft quote${data ? ` — ${data.quote.job_address}` : ''}`}
    >
      {/* Full-screen panel */}
      <div
        ref={panelRef}
        className={[
          'relative flex flex-col w-full h-full bg-white sm:max-w-3xl sm:mx-auto sm:my-6 sm:rounded-2xl sm:h-auto sm:max-h-[calc(100vh-3rem)] shadow-2xl',
          'transition-transform duration-220 ease-out',
          visible ? 'translate-y-0 sm:scale-100' : 'translate-y-8 sm:scale-95',
        ].join(' ')}
        style={{ transitionDuration: '220ms' }}
      >
        {/* ── Header ───────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-slate-200 bg-white sm:rounded-t-2xl flex-shrink-0 sticky top-0 z-10">
          <div className="flex items-center gap-3 min-w-0">
            <button
              ref={closeButtonRef}
              onClick={handleClose}
              className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors flex-shrink-0"
              aria-label="Close quote view"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
              </svg>
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-900 truncate">
                  {sentAt ? 'Quote' : 'Draft Quote'} v{data?.quote.version ?? 1}
                </h2>
                {data && !sentAt && <OverallConfidenceBadge score={data.quote.confidence_score} />}
                {sentAt && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-xs font-semibold">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    Sent
                  </span>
                )}
              </div>
              {data && (
                <p className="text-xs text-slate-500 truncate mt-0.5">
                  {data.quote.job_address}
                  {sentAt && (
                    <span className="ml-1 text-green-600">
                      &mdash; sent {new Date(sentAt).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  )}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ── Body (scrollable) ─────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {/* Loading state */}
          {isLoading && (
            <div className="pt-4">
              {/* Skeleton summary card */}
              <div className="mx-4 mb-4 border border-slate-200 rounded-xl overflow-hidden">
                <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
                  <div className="w-20 h-3 animate-pulse bg-slate-200 rounded" />
                </div>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100 last:border-0">
                    <div className="w-24 h-4 animate-pulse bg-slate-200 rounded" />
                    <div className="w-20 h-4 animate-pulse bg-slate-200 rounded" />
                  </div>
                ))}
              </div>
              <SkeletonCategory />
              <SkeletonCategory />
              <SkeletonCategory />
            </div>
          )}

          {/* Error state */}
          {!isLoading && error && (
            <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
              <svg
                className="w-10 h-10 text-red-400 mb-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                />
              </svg>
              <p className="text-sm text-red-600 font-medium">{error}</p>
              <button
                type="button"
                onClick={handleClose}
                className="mt-4 btn-secondary text-sm px-4 py-2"
              >
                Close
              </button>
            </div>
          )}

          {/* Quote data */}
          {!isLoading && !error && data && (
            <div className="pt-4 pb-2">
              {/* Summary card */}
              <SummaryCard summary={data.summary} />

              {/* Category sections */}
              {data.line_items_by_category.map((group) => (
                <CategorySection
                  key={group.category_id}
                  group={group}
                  isExpanded={expandedCategories.has(group.category_id)}
                  onToggle={() => toggleCategory(group.category_id)}
                />
              ))}

              {/* Bottom padding */}
              <div className="h-4" />
            </div>
          )}
        </div>

        {/* ── Action bar ────────────────────────────────────────────── */}
        {!isLoading && !error && data && (
          <ActionBar
            quoteId={quoteId}
            summary={data.summary}
            onSend={handleSendClick}
            onRevise={handleReviseClick}
            onExportPdf={handleExportPdfClick}
          />
        )}

        {/* ── Send Quote Modal ──────────────────────────────────────── */}
        <SendQuoteModal
          quoteId={quoteId}
          builderId={builderId}
          isOpen={sendModalOpen}
          onClose={() => setSendModalOpen(false)}
          onSent={handleSent}
        />
      </div>
    </div>
  )
}

// ─── Portal wrapper ───────────────────────────────────────────────────────────

export default function QuoteView(props: QuoteViewProps) {
  const [portalTarget, setPortalTarget] = useState<Element | null>(null)

  useEffect(() => {
    setPortalTarget(document.body)
  }, [])

  if (!portalTarget) return null
  return createPortal(<QuoteViewInner {...props} />, portalTarget)
}
