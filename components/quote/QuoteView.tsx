'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { DemoQuote, DemoQuoteLineItem, EstimateEvidence } from '@/lib/quote-demo'
import type { QAReport } from '@/lib/types/database.types'
import type { QualityGateResult } from '@/lib/estimating/quality-gate'
import { applyMargin } from '@/lib/pricing'
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
  /** total_cost marked up by margin_pct — what the client is quoted */
  client_price: number
  confidence_score: number
  unresolved_count: number
  assumption_count: number
  can_send: boolean
}

/** Stage 6 QA pass output (lib/estimating/qa.ts), passed through by the API unchanged. */
interface QASummary extends QAReport {
  overall_confidence: number | null
}

interface QuoteApiResponse {
  quote: DemoQuote
  line_items_by_category: LineItemsByCategory[]
  summary: QuoteSummary
  qa: QASummary | null
  evidence: EstimateEvidence | null
  quality_gate: QualityGateResult
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
        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--status-red)' }} aria-hidden="true" />
        <span className="text-[11px] font-medium whitespace-nowrap" style={{ color: 'var(--status-red)' }}>Needs input</span>
      </span>
    )
  }

  if (assumptionStatus === 'excluded') {
    return (
      <span className="flex items-center gap-1 flex-shrink-0">
        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--text-tertiary)' }} aria-hidden="true" />
        <span className="text-[11px] font-medium whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>Excluded</span>
      </span>
    )
  }

  if (confidence >= 85) {
    return (
      <span className="flex items-center gap-1 flex-shrink-0" title={`Confidence: ${confidence}%`}>
        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--status-green)' }} aria-hidden="true" />
        <span className="text-[11px] font-medium" style={{ color: 'var(--status-green)' }}>{confidence}%</span>
      </span>
    )
  }

  if (confidence >= 60) {
    return (
      <span className="flex items-center gap-1 flex-shrink-0" title={`Confidence: ${confidence}%`}>
        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--status-amber)' }} aria-hidden="true" />
        <span className="text-[11px] font-medium" style={{ color: 'var(--status-amber)' }}>{confidence}%</span>
      </span>
    )
  }

  return (
    <span className="flex items-center gap-1 flex-shrink-0" title={`Confidence: ${confidence}%`}>
      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--status-red)' }} aria-hidden="true" />
      <span className="text-[11px] font-medium" style={{ color: 'var(--status-red)' }}>{confidence}%</span>
    </span>
  )
}

// ─── Overall confidence badge ─────────────────────────────────────────────────

function OverallConfidenceBadge({ score }: { score: number }) {
  if (score >= 80) {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[13px] font-semibold"
        style={{ backgroundColor: 'rgba(76,175,80,0.15)', color: 'var(--status-green)' }}
      >
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--status-green)' }} aria-hidden="true" />
        {score}%
      </span>
    )
  }
  if (score >= 60) {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[13px] font-semibold"
        style={{ backgroundColor: 'rgba(255,152,0,0.1)', color: 'var(--status-amber)' }}
      >
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--status-amber)' }} aria-hidden="true" />
        {score}%
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[13px] font-semibold"
      style={{ backgroundColor: 'rgba(244,67,54,0.1)', color: 'var(--status-red)' }}
    >
      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--status-red)' }} aria-hidden="true" />
      {score}%
    </span>
  )
}

// ─── Skeleton row ─────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 last:border-0" style={{ borderBottom: '1px solid var(--bg-border)' }}>
      <div className="flex-1 animate-pulse rounded h-4" style={{ backgroundColor: 'var(--bg-elevated)' }} />
      <div className="w-16 animate-pulse rounded h-4" style={{ backgroundColor: 'var(--bg-elevated)' }} />
      <div className="w-16 animate-pulse rounded h-4" style={{ backgroundColor: 'var(--bg-elevated)' }} />
      <div className="w-16 animate-pulse rounded h-4" style={{ backgroundColor: 'var(--bg-elevated)' }} />
      <div className="w-16 animate-pulse rounded h-4" style={{ backgroundColor: 'var(--bg-elevated)' }} />
    </div>
  )
}

function SkeletonCategory() {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 animate-pulse rounded" style={{ backgroundColor: 'var(--bg-elevated)' }} />
          <div className="w-40 h-5 animate-pulse rounded" style={{ backgroundColor: 'var(--bg-elevated)' }} />
        </div>
        <div className="w-20 h-5 animate-pulse rounded" style={{ backgroundColor: 'var(--bg-elevated)' }} />
      </div>
      <div className="mx-4 overflow-hidden rounded-lg" style={{ border: '1px solid var(--bg-border)' }}>
        <SkeletonRow />
        <SkeletonRow />
      </div>
    </div>
  )
}

// ─── Pricing type tag ─────────────────────────────────────────────────────────

function PricingTypeTag({ type }: { type: DemoQuoteLineItem['pricing_type'] }) {
  if (type === 'pc_allowance') {
    return (
      <span
        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide"
        style={{ backgroundColor: 'rgba(255,152,0,0.1)', color: 'var(--status-amber)' }}
      >
        PC
      </span>
    )
  }
  if (type === 'provisional_sum') {
    return (
      <span
        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide"
        style={{ backgroundColor: 'rgba(255,152,0,0.1)', color: 'var(--status-amber)' }}
      >
        PS
      </span>
    )
  }
  return null
}

// ─── Line item row ────────────────────────────────────────────────────────────

interface LineItemRowProps {
  key?: string | number
  item: DemoQuoteLineItem
}

function LineItemRow({ item }: LineItemRowProps) {
  const isExcluded = item.assumption_status === 'excluded'
  const isUnresolved = item.is_assumption && item.assumption_status === 'unresolved'
  const isAllowance = item.pricing_type === 'pc_allowance' || item.pricing_type === 'provisional_sum'

  // item.margin_pct is stored as a 0-1 fraction (migration 012); applyMargin
  // expects a 0-100 percent — convert rather than reimplementing the markup
  // formula inline, so this and the quote-level summary never drift apart.
  const sellTotal = item.total !== null ? Math.round(applyMargin(item.total, item.margin_pct * 100)) : null

  return (
    <div
      className={['flex items-start gap-2 px-3 py-2.5 last:border-0', isExcluded ? 'opacity-60' : ''].filter(Boolean).join(' ')}
      style={{
        borderBottom: '1px solid var(--bg-border)',
        backgroundColor: isUnresolved ? 'rgba(244,67,54,0.06)' : undefined,
      }}
      role="row"
    >
      {/* Description — takes most space */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className="text-[13px] leading-tight"
            style={{
              color: isExcluded ? 'var(--text-tertiary)' : 'var(--text-primary)',
              textDecoration: isExcluded ? 'line-through' : undefined,
            }}
          >
            {item.description}
          </span>
          <PricingTypeTag type={item.pricing_type} />
        </div>
        {item.dimensions_string && !isExcluded && (
          <span className="text-[11px] block truncate mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
            {item.dimensions_string}
          </span>
        )}
        {item.source_ref && !isExcluded && (
          <span className="text-[11px] block mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
            {item.source_ref}
          </span>
        )}
      </div>

      {/* Qty + unit — hidden for allowances */}
      {!isAllowance && (
        <div className="flex-shrink-0 text-right w-14 sm:w-20">
          <span
            className="text-[13px] tabular-nums"
            style={{
              color: isExcluded ? 'var(--text-tertiary)' : 'var(--text-secondary)',
              textDecoration: isExcluded ? 'line-through' : undefined,
            }}
          >
            {formatQuantity(item.quantity)}
            {item.unit ? (
              <span className="text-[11px] ml-0.5" style={{ color: 'var(--text-tertiary)' }}>{item.unit}</span>
            ) : (
              <span className="text-[11px] ml-0.5" style={{ color: 'var(--status-red)' }}>[?]</span>
            )}
          </span>
        </div>
      )}
      {isAllowance && <div className="flex-shrink-0 w-14 sm:w-20" />}

      {/* Rate — visible on all viewports; pricing context a builder needs
          before sending shouldn't be desktop-only */}
      <div className="flex-shrink-0 text-right w-14 sm:w-20">
        <span
          className="text-[13px] tabular-nums"
          style={{
            color: isExcluded ? 'var(--text-tertiary)' : 'var(--text-secondary)',
            textDecoration: isExcluded ? 'line-through' : undefined,
          }}
        >
          {isAllowance ? 'Allowance' : formatRate(item.rate)}
        </span>
      </div>

      {/* Sell total (cost + margin) */}
      <div className="flex-shrink-0 text-right w-16 sm:w-24">
        <span
          className="text-[13px] font-medium tabular-nums"
          style={{
            color: isExcluded ? 'var(--text-tertiary)' : 'var(--text-primary)',
            textDecoration: isExcluded ? 'line-through' : undefined,
          }}
        >
          {isExcluded ? 'Excluded' : (sellTotal !== null ? formatCurrency(sellTotal) : formatTotal(item.total))}
        </span>
        {!isExcluded && item.margin_pct > 0 && item.total !== null && (
          <span className="text-[10px] block" style={{ color: 'var(--text-tertiary)' }}>{Math.round(item.margin_pct * 100)}% margin</span>
        )}
        {!isExcluded && item.pricing_type === 'provisional_sum' && (
          <span className="text-[10px] block" style={{ color: 'var(--status-amber)' }}>0% margin</span>
        )}
      </div>

      {/* Confidence indicator — visible on all viewports, not just desktop */}
      <div className="flex flex-shrink-0 w-16 sm:w-24 justify-end">
        <ConfidenceIndicator
          confidence={item.confidence}
          isAssumption={item.is_assumption}
          assumptionStatus={item.assumption_status}
        />
      </div>
    </div>
  )
}

// ─── PC/PS Register ───────────────────────────────────────────────────────────

interface PcPsRegisterProps {
  items: DemoQuoteLineItem[]
}

function PcPsRegister({ items }: PcPsRegisterProps) {
  const pcItems = items.filter(i => i.pricing_type === 'pc_allowance')
  const psItems = items.filter(i => i.pricing_type === 'provisional_sum')

  if (pcItems.length === 0 && psItems.length === 0) return null

  const pcTotal = pcItems.reduce((s, i) => s + (i.total ?? 0), 0)
  const psTotal = psItems.reduce((s, i) => s + (i.total ?? 0), 0)

  return (
    <div className="mx-4 mb-4 rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,152,0,0.3)' }}>
      <div className="px-4 py-2" style={{ backgroundColor: 'rgba(255,152,0,0.08)', borderBottom: '1px solid rgba(255,152,0,0.2)' }}>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--status-amber)' }}>
          PC &amp; Provisional Sum Register
        </h3>
        <p className="text-[11px] mt-0.5" style={{ color: 'var(--status-amber)' }}>
          These amounts are estimates. Final costs depend on client selections (PC) or actual scope (PS).
        </p>
      </div>
      {pcItems.length > 0 && (
        <div style={{ borderBottom: '1px solid rgba(255,152,0,0.15)' }}>
          <div className="px-4 py-1.5" style={{ backgroundColor: 'var(--bg-elevated)' }}>
            <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--status-amber)' }}>Prime Cost Allowances</span>
          </div>
          {pcItems.map(item => (
            <div
              key={item.id}
              className="flex items-center justify-between px-4 py-2"
              style={{ borderTop: '1px solid rgba(255,152,0,0.08)', backgroundColor: 'var(--bg-surface)' }}
            >
              <div>
                <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{item.description}</span>
                {item.source_ref && <span className="text-[11px] ml-2" style={{ color: 'var(--text-tertiary)' }}>{item.source_ref}</span>}
              </div>
              <span className="text-[13px] font-medium tabular-nums" style={{ color: 'var(--text-primary)' }}>{formatCurrency(item.total ?? 0)}</span>
            </div>
          ))}
          <div
            className="flex items-center justify-between px-4 py-2"
            style={{ backgroundColor: 'rgba(255,152,0,0.08)', borderTop: '1px solid rgba(255,152,0,0.15)' }}
          >
            <span className="text-[11px] font-semibold" style={{ color: 'var(--status-amber)' }}>PC Total</span>
            <span className="text-[13px] font-bold tabular-nums" style={{ color: 'var(--status-amber)' }}>{formatCurrency(pcTotal)}</span>
          </div>
        </div>
      )}
      {psItems.length > 0 && (
        <div>
          <div className="px-4 py-1.5" style={{ backgroundColor: 'var(--bg-elevated)' }}>
            <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--status-amber)' }}>Provisional Sums</span>
          </div>
          {psItems.map(item => (
            <div
              key={item.id}
              className="flex items-center justify-between px-4 py-2"
              style={{ borderTop: '1px solid rgba(255,152,0,0.08)', backgroundColor: 'var(--bg-surface)' }}
            >
              <div>
                <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{item.description}</span>
                {item.source_ref && <span className="text-[11px] ml-2" style={{ color: 'var(--text-tertiary)' }}>{item.source_ref}</span>}
              </div>
              <span className="text-[13px] font-medium tabular-nums" style={{ color: 'var(--text-primary)' }}>{formatCurrency(item.total ?? 0)}</span>
            </div>
          ))}
          <div
            className="flex items-center justify-between px-4 py-2"
            style={{ backgroundColor: 'rgba(255,152,0,0.08)', borderTop: '1px solid rgba(255,152,0,0.15)' }}
          >
            <span className="text-[11px] font-semibold" style={{ color: 'var(--status-amber)' }}>PS Total (0% margin)</span>
            <span className="text-[13px] font-bold tabular-nums" style={{ color: 'var(--status-amber)' }}>{formatCurrency(psTotal)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Category section ─────────────────────────────────────────────────────────

interface CategorySectionProps {
  key?: string | number
  group: LineItemsByCategory
  isExpanded: boolean
  onToggle: () => void
}

function CategorySection({ group, isExpanded, onToggle }: CategorySectionProps) {
  const hasUnresolved = group.items.some(
    (i) => i.is_assumption && i.assumption_status === 'unresolved'
  )
  const onlyAllowances = group.items.length > 0 && group.items.every(
    (i) => i.pricing_type === 'pc_allowance' || i.pricing_type === 'provisional_sum'
  )

  return (
    <div className="mb-2">
      {/* Category header — clickable */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 transition-colors text-left rounded-lg"
        style={{ color: 'inherit' }}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--bg-elevated)')}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
        aria-expanded={isExpanded}
        aria-controls={`category-${group.category_id}`}
      >
        <div className="flex items-center gap-2">
          {/* Chevron */}
          <svg
            className={`w-4 h-4 transition-transform duration-200 ${isExpanded ? 'rotate-0' : '-rotate-90'}`}
            style={{ color: 'var(--text-tertiary)' }}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
          <span className="text-[13px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
            {group.category_name}
          </span>
          {hasUnresolved && (
            <span
              className="text-[13px] leading-none ml-1"
              style={{ color: 'var(--status-amber)' }}
              aria-label="Has unresolved items"
              title="Has unresolved assumptions"
            >
              ⚠
            </span>
          )}
          {!hasUnresolved && onlyAllowances && (
            <span
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded ml-1"
              style={{ backgroundColor: 'rgba(255,152,0,0.1)', color: 'var(--status-amber)' }}
              title="All items in this category are PC allowances or provisional sums"
            >
              PC/PS
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>
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
        <div className="mx-4 mb-2 rounded-lg overflow-hidden" style={{ border: '1px solid var(--bg-border)' }}>
          {/* Column headers — hidden on mobile, visible on sm+ */}
          <div
            className="hidden sm:flex items-center gap-2 px-3 py-1.5"
            style={{ backgroundColor: 'var(--bg-elevated)', borderBottom: '1px solid var(--bg-border)' }}
          >
            <div className="flex-1 text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
              Description
            </div>
            <div className="flex-shrink-0 w-20 text-right text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
              Qty
            </div>
            <div className="flex-shrink-0 w-20 text-right text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
              Rate
            </div>
            <div className="flex-shrink-0 w-24 text-right text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
              Total
            </div>
            <div className="flex-shrink-0 w-24 text-right text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
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
    <div className="mx-4 mb-4 rounded-xl overflow-hidden shadow-sm" style={{ border: '1px solid var(--bg-border)' }}>
      <div className="px-4 py-2" style={{ backgroundColor: 'var(--bg-elevated)', borderBottom: '1px solid var(--bg-border)' }}>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>Summary</h3>
      </div>
      <div style={{ backgroundColor: 'var(--bg-surface)' }}>
        <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: '1px solid var(--bg-border)' }}>
          <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>Cost (before margin)</span>
          <span className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--text-secondary)' }}>
            {formatCurrency(summary.total_cost)}
          </span>
        </div>
        <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: '1px solid var(--bg-border)' }}>
          <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>Margin</span>
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{summary.margin_pct}%</span>
        </div>
        <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: '1px solid var(--bg-border)', backgroundColor: 'var(--bg-elevated)' }}>
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>Client price</span>
          <span className="text-[14px] font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>
            {formatCurrency(summary.client_price ?? summary.total_cost)}
          </span>
        </div>
        <div
          className="flex items-center justify-between px-4 py-2.5"
          style={{ borderBottom: summary.unresolved_count > 0 || summary.assumption_count > 0 ? '1px solid var(--bg-border)' : undefined }}
        >
          <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>Confidence</span>
          <div className="flex items-center gap-2">
            <OverallConfidenceBadge score={summary.confidence_score} />
            <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{confidenceLabel}</span>
          </div>
        </div>
        {summary.unresolved_count > 0 && (
          <div className="flex items-center gap-2 px-4 py-2.5" style={{ backgroundColor: 'rgba(244,67,54,0.08)' }}>
            <svg
              className="w-4 h-4 flex-shrink-0"
              style={{ color: 'var(--status-red)' }}
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
            <span className="text-[13px] font-medium" style={{ color: 'var(--status-red)' }}>
              {summary.unresolved_count} item{summary.unresolved_count !== 1 ? 's' : ''} need
              {summary.unresolved_count === 1 ? 's' : ''} your input before sending
            </span>
          </div>
        )}
        {summary.unresolved_count === 0 && summary.assumption_count > 0 && (
          <div className="flex items-center gap-2 px-4 py-2.5" style={{ backgroundColor: 'rgba(76,175,80,0.08)' }}>
            <svg
              className="w-4 h-4 flex-shrink-0"
              style={{ color: 'var(--status-green)' }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-[13px] font-medium" style={{ color: 'var(--status-green)' }}>
              All assumptions resolved — quote is ready to send
            </span>
          </div>
        )}
        {summary.unresolved_count === 0 && summary.assumption_count === 0 && (
          <div className="flex items-center gap-2 px-4 py-2.5" style={{ backgroundColor: 'rgba(76,175,80,0.08)' }}>
            <svg
              className="w-4 h-4 flex-shrink-0"
              style={{ color: 'var(--status-green)' }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-[13px] font-medium" style={{ color: 'var(--status-green)' }}>
              Quote is ready to send
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── QA review panel ──────────────────────────────────────────────────────────
// Renders quotes.qa_report / overall_confidence (lib/estimating/qa.ts) — never
// recomputes anything, purely translates what QA already found into
// builder-facing language. Answers, from existing data: what assumptions were
// made (summary.assumption_count/unresolved_count), what risks could affect
// price (qa.top_risks), and what needs review before sending
// (qa.review_items + qa.recommended_actions).

// ─── Estimate Evidence — Phase 1.5 ────────────────────────────────────────────
// Renders quote.evidence (built in app/api/quotes/[quoteId]/route.ts by
// aggregating project_documents / files / scope_items / quote_line_items —
// no new computation, see buildEstimateEvidence there). Answers "what
// information did NWT receive / extract" — the two Trust Model questions
// the QA report itself doesn't cover.

function EvidenceRow({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-[13px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
      <span aria-hidden="true" className="flex-shrink-0" style={{ color: ok ? 'var(--status-green)' : 'var(--status-amber)' }}>
        {ok ? '✓' : '⚠'}
      </span>
      <span>{children}</span>
    </li>
  )
}

function EstimateEvidenceSection({
  evidence,
  exposure,
}: {
  evidence: EstimateEvidence | null
  exposure: QualityGateResult['exposure'] | null
}) {
  if (!evidence) return null

  const {
    documents_processed, document_types, missing_documents,
    scope_items_identified, line_items_generated,
    fixed_price_count, pc_ps_count, assumed_count, needs_review_count,
  } = evidence

  const scopeGap = scope_items_identified - line_items_generated
  const pcPsValue = exposure ? exposure.pc_allowance_value + exposure.provisional_sum_value : null
  const assumptionValue = exposure ? exposure.unresolved_assumption_value + exposure.resolved_assumption_value : null

  return (
    <div className="px-4 py-3" style={{ backgroundColor: 'var(--bg-surface)', borderTop: '1px solid var(--bg-border)' }}>
      <p className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-tertiary)' }}>
        Estimate Evidence
      </p>

      {/*
        Terminology note: every label here describes what NWT *did*
        (reviewed, identified, generated), never what it *confirmed* — this
        section is coverage, not a validation or correctness claim. See the
        captions under each heading for the specific caveat.
      */}
      <p className="text-[11px] font-medium uppercase tracking-wide mt-2 mb-1" style={{ color: 'var(--text-tertiary)' }}>
        Sources reviewed
      </p>
      <ul className="space-y-1">
        {documents_processed > 0 ? (
          <EvidenceRow ok>
            {documents_processed} document{documents_processed !== 1 ? 's' : ''} processed
            {document_types.length > 0 ? ` (${document_types.join(', ')})` : ''}
          </EvidenceRow>
        ) : (
          <EvidenceRow ok={false}>No sources reviewed for this job — quantities came from a plain-English description.</EvidenceRow>
        )}
        {missing_documents.length > 0 && (
          <EvidenceRow ok={false}>
            {missing_documents.length} file{missing_documents.length !== 1 ? 's' : ''} could not be processed: {missing_documents.join(', ')}
          </EvidenceRow>
        )}
      </ul>

      <p className="text-[11px] font-medium uppercase tracking-wide mt-3 mb-1" style={{ color: 'var(--text-tertiary)' }}>
        Scope identified
      </p>
      <ul className="space-y-1">
        <EvidenceRow ok={scope_items_identified > 0}>
          {scope_items_identified} scope item{scope_items_identified !== 1 ? 's' : ''} identified
        </EvidenceRow>
        <EvidenceRow ok>
          {line_items_generated} priced line item{line_items_generated !== 1 ? 's' : ''} generated
        </EvidenceRow>
        {scopeGap > 0 && (
          <EvidenceRow ok={false}>
            {scopeGap} scope item{scopeGap !== 1 ? 's' : ''} identified but not yet reflected in a priced line item
          </EvidenceRow>
        )}
      </ul>

      <p className="text-[11px] font-medium uppercase tracking-wide mt-3 mb-1" style={{ color: 'var(--text-tertiary)' }}>
        Pricing breakdown
      </p>
      <p className="text-[11px] mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
        A fixed price means a rate was resolved — not that the quantity or rate is guaranteed correct.
      </p>
      <ul className="space-y-1">
        <EvidenceRow ok>
          {fixed_price_count} fixed-price item{fixed_price_count !== 1 ? 's' : ''}
        </EvidenceRow>
        {pc_ps_count > 0 && (
          <EvidenceRow ok={false}>
            {pc_ps_count} provisional sum{pc_ps_count !== 1 ? 's' : ''}
            {pcPsValue !== null ? ` — ${formatCurrency(pcPsValue)}` : ''} — final cost depends on client selection or actual scope
          </EvidenceRow>
        )}
        {assumed_count > 0 && (
          <EvidenceRow ok={false}>
            {assumed_count} assumption{assumed_count !== 1 ? 's' : ''}
            {assumptionValue !== null ? ` — ${formatCurrency(assumptionValue)}` : ''} — a visible uncertainty, not an error
            {needs_review_count > 0 ? `; ${needs_review_count} still requiring review` : ' (already reviewed)'}
          </EvidenceRow>
        )}
        {exposure && (
          <EvidenceRow ok={exposure.exposed_pct < 10}>
            {formatCurrency(exposure.exposed_value)} total ({exposure.exposed_pct}% of quote value) is exposed to PC/PS allowances or assumptions
          </EvidenceRow>
        )}
      </ul>
    </div>
  )
}

interface QAReviewPanelProps {
  qa: QASummary | null
  evidence: EstimateEvidence | null
  qualityGate: QualityGateResult
  unresolvedCount: number
  assumptionCount: number
  hasFlaggedItems: boolean
  onJumpToFlagged: () => void
}

function QAReviewPanel({ qa, evidence, qualityGate, unresolvedCount, assumptionCount, hasFlaggedItems, onJumpToFlagged }: QAReviewPanelProps) {
  // Neither QA nor evidence has anything to show yet (e.g. quote just
  // priced, QA/evidence backfill pending) — nothing to render.
  if (!qa && !evidence) return null

  const confidence = qa?.overall_confidence ?? 0

  // "Before sending" mirrors exactly what's gating the send button
  // (qualityGate.blocked_reasons / review_reasons), not a separately-derived
  // qa.top_risks list — same reason a mismatch between what's shown and
  // what's enforced would be the exact bug this phase exists to close.
  // qa.review_items is always informational-only regardless of state (see
  // the note on top_risks gating in lib/estimating/quality-gate.ts) and is
  // shown separately below, never folded into the gating reasons.
  const gatingReasons =
    qualityGate.state === 'blocked' ? qualityGate.blocked_reasons
    : qualityGate.state === 'review_required' ? qualityGate.review_reasons
    : []
  const reviewItems = qa?.review_items ?? []
  const beforeSendingItems = [...gatingReasons, ...reviewItems]

  // Status label is driven by the SAME quality_gate the send button itself
  // is gated on (lib/estimating/quality-gate.ts) — previously this panel
  // derived its own confidence-band heuristic here, which could drift from
  // what actually gated sending. One decision, one place, two renderings.
  let statusLabel: string
  let statusColor: string
  if (qualityGate.state === 'blocked') {
    statusLabel = 'Blocked — must be fixed before sending'
    statusColor = 'var(--status-red)'
  } else if (qualityGate.state === 'review_required') {
    statusLabel = 'Review required before sending'
    statusColor = 'var(--status-amber)'
  } else {
    statusLabel = 'Ready to send'
    statusColor = 'var(--status-green)'
  }

  return (
    <div className="mx-4 mb-4 rounded-xl overflow-hidden shadow-sm" style={{ border: '1px solid var(--bg-border)' }}>
      {qa && (
        <>
          {/* Confidence + readiness — always visible, no hidden columns on mobile */}
          <div className="px-4 py-3" style={{ backgroundColor: 'var(--bg-elevated)', borderBottom: '1px solid var(--bg-border)' }}>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
              Estimate Confidence
            </h3>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-[20px] font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>{confidence}%</span>
              <span
                className="text-[12px] font-semibold px-2 py-0.5 rounded-full"
                style={{ color: statusColor, backgroundColor: 'var(--bg-surface)', border: `1px solid ${statusColor}` }}
              >
                {statusLabel}
              </span>
            </div>
            {assumptionCount > 0 && (
              <p className="text-[12px] mt-1.5" style={{ color: 'var(--text-tertiary)' }}>
                {assumptionCount} line item{assumptionCount !== 1 ? 's are' : ' is'} based on an assumption rather than confirmed evidence
                {unresolvedCount > 0 ? `, ${unresolvedCount} still unresolved` : ''}.
              </p>
            )}
          </div>

          {/* Before sending — the merged, plain-language risk + review list */}
          {beforeSendingItems.length > 0 ? (
            <div className="px-4 py-3" style={{ backgroundColor: 'var(--bg-surface)' }}>
              <p className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-tertiary)' }}>
                Before sending
              </p>
              <ul className="space-y-1.5">
                {beforeSendingItems.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
                    <span aria-hidden="true" className="flex-shrink-0" style={{ color: 'var(--status-amber)' }}>⚠</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              {hasFlaggedItems && (
                <button
                  type="button"
                  onClick={onJumpToFlagged}
                  className="mt-3 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors"
                  style={{ color: 'var(--orange-primary)', border: '1px solid var(--orange-primary)' }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--orange-subtle)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
                >
                  Jump to flagged items
                </button>
              )}
            </div>
          ) : (
            <div className="px-4 py-3 flex items-center gap-2" style={{ backgroundColor: 'rgba(76,175,80,0.08)' }}>
              <svg className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--status-green)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-[13px] font-medium" style={{ color: 'var(--status-green)' }}>
                No risks flagged — this estimate is ready for review.
              </span>
            </div>
          )}

          {/* Recommended — informational, not separately-clickable per item (the
              underlying qa_report doesn't carry per-action targets) */}
          {qa.recommended_actions.length > 0 && (
            <div className="px-4 py-3" style={{ backgroundColor: 'var(--bg-surface)', borderTop: '1px solid var(--bg-border)' }}>
              <p className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-tertiary)' }}>
                Recommended
              </p>
              <ul className="space-y-1">
                {qa.recommended_actions.map((action, i) => (
                  <li key={i} className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>{action}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {/* Estimate Evidence — what information NWT received and extracted,
          independent of whether QA has run */}
      <EstimateEvidenceSection evidence={evidence} exposure={qualityGate.exposure} />
    </div>
  )
}

// ─── Action bar ───────────────────────────────────────────────────────────────

interface ActionBarProps {
  quoteId: string
  summary: QuoteSummary
  qualityGate: QualityGateResult
  onSend: (quoteId: string) => void
  onRevise: (quoteId: string) => void
  onExportPdf: (quoteId: string) => void
}

function ActionBar({ quoteId, summary, qualityGate, onSend, onRevise, onExportPdf }: ActionBarProps) {
  const isBlocked = qualityGate.state === 'blocked'
  const isReviewRequired = qualityGate.state === 'review_required'

  return (
    <div
      className="flex-shrink-0 px-4 py-3"
      style={{ borderTop: '1px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)' }}
    >
      {isBlocked && (
        <p className="text-[13px] font-medium mb-2 flex items-start gap-1.5" style={{ color: 'var(--status-red)' }}>
          <svg
            className="w-4 h-4 flex-shrink-0 mt-0.5"
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
          <span>{qualityGate.blocked_reasons.join(' ')}</span>
        </p>
      )}
      {isReviewRequired && (
        <p className="text-[13px] font-medium mb-2 flex items-center gap-1.5" style={{ color: 'var(--status-amber)' }}>
          <span aria-hidden="true">⚠</span>
          <span>Flagged risks require your acknowledgement before sending.</span>
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSend(quoteId)}
          disabled={isBlocked}
          title={
            isBlocked
              ? qualityGate.blocked_reasons.join(' ')
              : isReviewRequired
              ? 'Review flagged risks before sending'
              : 'Send quote to client'
          }
          className="btn-primary px-4 py-2 text-[13px] disabled:opacity-40 disabled:cursor-not-allowed flex-1 sm:flex-none"
          style={isReviewRequired ? { backgroundColor: 'var(--status-amber)' } : undefined}
        >
          Send to client
        </button>
        <button
          type="button"
          onClick={() => onExportPdf(quoteId)}
          disabled={isBlocked}
          title={isBlocked ? qualityGate.blocked_reasons.join(' ') : 'Export a client-facing PDF'}
          className="btn-secondary px-4 py-2 text-[13px] flex-1 sm:flex-none disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Export PDF
        </button>
        <button
          type="button"
          onClick={() => onRevise(quoteId)}
          className="px-4 py-2 text-[13px] font-medium rounded-lg transition-colors flex-1 sm:flex-none"
          style={{ color: 'var(--text-secondary)' }}
          onMouseEnter={e => {
            e.currentTarget.style.color = 'var(--text-primary)'
            e.currentTarget.style.backgroundColor = 'var(--bg-elevated)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.color = 'var(--text-secondary)'
            e.currentTarget.style.backgroundColor = ''
          }}
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
        const focusable = Array.from<HTMLElement>(
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
      // Guard against empty quoteId (can happen if SSE pipeline didn't return one)
      if (!quoteId || quoteId === 'demo-quote-id') {
        // In demo mode or when no real quoteId, fall back to the demo endpoint
        // which always returns 200 with placeholder data.
      }
      try {
        const res = await fetch(`/api/quotes/${quoteId}`)
        if (!res.ok) {
          const status = res.status
          if (status === 401) {
            setError('Session expired — please refresh the page and try again.')
          } else if (status === 404) {
            setError('Quote not found — it may still be processing. Try again in a moment.')
          } else {
            setError('Failed to load quote. Please try again.')
          }
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

  // Export PDF — open in new tab. Gated the same way sending is: the
  // ActionBar button is disabled entirely when BLOCKED, and REVIEW_REQUIRED
  // (not yet acknowledged) asks for explicit confirmation naming the
  // specific exposure before appending ?risk_acknowledged=true — the server
  // re-checks this regardless (see export-pdf/route.ts), this is just so
  // the builder isn't surprised by what exporting records.
  const handleExportPdfClick = useCallback((_qId: string) => {
    if (!data) return
    const gate = data.quality_gate
    const alreadyAcknowledged = Boolean(data.quote.risk_acknowledged_at)

    let url = `/api/quotes/${quoteId}/export-pdf`
    if (gate.state === 'review_required' && !alreadyAcknowledged) {
      const confirmed = window.confirm(
        `This quote has flagged risks — $${gate.exposure.exposed_value.toLocaleString('en-AU')} ` +
        `(${gate.exposure.exposed_pct}% of quote value) exposed to PC/PS allowances or assumptions.\n\n` +
        `Exporting this PDF will record that you've reviewed and accepted these risks. Continue?`
      )
      if (!confirmed) return
      url += '?risk_acknowledged=true'
    }

    window.open(url, '_blank')
    onExportPdf(quoteId)
  }, [quoteId, onExportPdf, data])

  // Revise — close and let the parent (ChatInterface.handleQuoteViewRevise)
  // make the single POST to /revise and report the outcome. This component
  // used to ALSO fire its own POST here, which meant every click created
  // two revised quote versions instead of one.
  const handleReviseClick = useCallback((_qId: string) => {
    onRevise(quoteId)
    handleClose()
  }, [quoteId, onRevise, handleClose])

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

  // A "flagged" item is exactly what the QA panel's warnings describe:
  // an unresolved assumption, or a line item below the 50% confidence
  // threshold qa.ts itself uses for its low-confidence risk.
  const isFlaggedItem = (item: DemoQuoteLineItem) =>
    (item.is_assumption && item.assumption_status === 'unresolved') || item.confidence < 50

  const hasFlaggedItems = data?.line_items_by_category.some((g) => g.items.some(isFlaggedItem)) ?? false

  const jumpToFlagged = useCallback(() => {
    if (!data) return
    const flaggedIds = data.line_items_by_category
      .filter((g) => g.items.some(isFlaggedItem))
      .map((g) => g.category_id)
    setExpandedCategories(new Set(flaggedIds))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

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
      aria-label={`Quote${data ? ` — ${data.quote.job_address}` : ''}`}
    >
      {/* Full-screen panel */}
      <div
        ref={panelRef}
        className={[
          'relative flex flex-col w-full h-full sm:max-w-3xl sm:mx-auto sm:my-6 sm:rounded-2xl sm:h-auto sm:max-h-[calc(100vh-3rem)] shadow-2xl',
          'transition-transform duration-220 ease-out',
          visible ? 'translate-y-0 sm:scale-100' : 'translate-y-8 sm:scale-95',
        ].join(' ')}
        style={{ backgroundColor: 'var(--bg-surface)', transitionDuration: '220ms' }}
      >
        {/* ── Header ───────────────────────────────────────────────── */}
        <div
          className="flex items-center justify-between px-4 pt-4 pb-3 sm:rounded-t-2xl flex-shrink-0 sticky top-0 z-10"
          style={{ borderBottom: '1px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)' }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <button
              ref={closeButtonRef}
              onClick={handleClose}
              className="w-8 h-8 flex items-center justify-center rounded-full transition-colors flex-shrink-0"
              style={{ color: 'var(--text-tertiary)' }}
              onMouseEnter={e => {
                e.currentTarget.style.color = 'var(--text-primary)'
                e.currentTarget.style.backgroundColor = 'var(--bg-elevated)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.color = 'var(--text-tertiary)'
                e.currentTarget.style.backgroundColor = ''
              }}
              aria-label="Close quote view"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
              </svg>
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold truncate" style={{ color: 'var(--text-primary)' }}>
                  Quote v{data?.quote.version ?? 1}
                </h2>
                {data && !sentAt && (
                  <span
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold"
                    style={{ backgroundColor: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
                  >
                    Draft
                  </span>
                )}
                {data && !sentAt && <OverallConfidenceBadge score={data.quote.confidence_score} />}
                {sentAt && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold"
                    style={{ backgroundColor: 'rgba(76,175,80,0.15)', color: 'var(--status-green)' }}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    Sent
                  </span>
                )}
              </div>
              {data && (
                <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  {data.quote.job_address}
                  {sentAt && (
                    <span className="ml-1" style={{ color: 'var(--status-green)' }}>
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
              <div className="mx-4 mb-4 rounded-xl overflow-hidden" style={{ border: '1px solid var(--bg-border)' }}>
                <div className="px-4 py-2" style={{ backgroundColor: 'var(--bg-elevated)', borderBottom: '1px solid var(--bg-border)' }}>
                  <div className="w-20 h-3 animate-pulse rounded" style={{ backgroundColor: 'var(--bg-border)' }} />
                </div>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between px-4 py-2.5 last:border-0"
                    style={{ borderBottom: '1px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)' }}
                  >
                    <div className="w-24 h-4 animate-pulse rounded" style={{ backgroundColor: 'var(--bg-elevated)' }} />
                    <div className="w-20 h-4 animate-pulse rounded" style={{ backgroundColor: 'var(--bg-elevated)' }} />
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
                className="w-10 h-10 mb-3"
                style={{ color: 'var(--status-red)' }}
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
              <p className="text-[13px] font-medium" style={{ color: 'var(--status-red)' }}>{error}</p>
              <button
                type="button"
                onClick={handleClose}
                className="mt-4 btn-secondary text-[13px] px-4 py-2"
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

              {/* QA review — confidence, risks, and what needs review before sending */}
              <QAReviewPanel
                qa={data.qa}
                evidence={data.evidence}
                qualityGate={data.quality_gate}
                unresolvedCount={data.summary.unresolved_count}
                assumptionCount={data.summary.assumption_count}
                hasFlaggedItems={hasFlaggedItems}
                onJumpToFlagged={jumpToFlagged}
              />

              {/* PC/PS register */}
              {(() => {
                const allItems = data.line_items_by_category.flatMap(g => g.items)
                return <PcPsRegister items={allItems} />
              })()}

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
            qualityGate={data.quality_gate}
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
          qualityGate={data?.quality_gate ?? null}
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
