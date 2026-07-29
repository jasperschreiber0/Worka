'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { DemoQuote, DemoQuoteLineItem } from '@/lib/quote-demo'
import { calculateSellTotal, calculateClientPrice } from '@/lib/pricing'
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

interface CriticalAssumption {
  id: string
  question: string
  assumed_value: string
  reason: string
  confidence_penalty: number
  trade_category_id: number | null
  resolved: boolean
}

interface QuoteSummary {
  total_cost: number
  margin_pct: number
  /** total_cost marked up by margin_pct — what the client is quoted */
  client_price: number
  /** "excl. GST" — from the API; see lib/pricing.ts PRICE_BASIS_LABEL. Optional for older cached responses. */
  price_basis?: string
  confidence_score: number
  /** "How reliable is this PRICE" — alias of confidence_score, for display next to scope_confidence. Optional for older cached responses. */
  pricing_confidence?: number
  /** "Is the SCOPE complete and internally consistent" — independent of pricing. Null until QA has run. */
  scope_confidence?: number | null
  /** MIN(pricing_confidence, scope_confidence). Null until QA has run. */
  overall_estimate_confidence?: number | null
  unresolved_count: number
  assumption_count: number
  unpriced_count: number
  readiness: 'ready' | 'review_required' | 'blocked'
  blocked_reasons: string[]
  review_reasons: string[]
  can_send: boolean
  /** WorkA assumed these to avoid blocking the estimate — see WORKA_IMPLEMENTATION notes on non-blocking estimation. Optional for older cached responses. */
  critical_assumptions?: CriticalAssumption[]
}

interface ConstructionSanityFindingPayload {
  id: string
  severity: 'red' | 'amber'
  summary: string
  what_noticed: string
  why_it_matters: string
  builder_action: string
}

interface QAReportPayload {
  top_risks: string[]
  review_items: string[]
  recommended_actions: string[]
  /** Construction-reasoning findings — see lib/estimating/construction-sanity.ts. Optional for older cached responses. */
  construction_sanity_findings?: ConstructionSanityFindingPayload[]
  /** "Why is this estimate lower than expected" — trade coverage vs. what this project's own characteristics imply. Optional for older cached responses. */
  construction_coverage?: {
    expected_trade_count: number
    detected_trade_count: number
    missing_trade_ids: number[]
    missing_trade_names: string[]
    detected_characteristics: string[]
  }
}

interface DocumentContributionPayload {
  documents: Array<{ document_id: string; name: string; facts_extracted: number; facts_used: number }>
  other_sources: { facts_extracted: number; facts_used: number } | null
  excluded: string[]
  failed: string[]
}

interface QuoteApiResponse {
  quote: DemoQuote
  line_items_by_category: LineItemsByCategory[]
  summary: QuoteSummary
  qa_report: QAReportPayload | null
  document_contribution: DocumentContributionPayload | null
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

// Human-readable label for pricing_source — the "where did this rate come
// from" the pricing-intelligence investigation confirmed was computed and
// stored (quote_line_items.pricing_source/pricing_basis) but never actually
// shown to the builder anywhere. This is display only; no new computation.
const PRICING_SOURCE_LABELS: Record<string, string> = {
  document: 'From your documents',
  cost_rates_exact: 'Platform rate',
  cost_rates_normalized: 'Platform rate (approx. match)',
  builder_rate: 'Your rate',
  network_rate: 'Network rate',
  category_rate: 'Category average',
  ai_measured_rate: 'AI estimate',
  retail_baseline: 'Retail baseline + labour benchmark',
  ai_allowance: 'AI allowance',
  manual: 'Manually priced',
}

function pricingSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null
  return PRICING_SOURCE_LABELS[source] ?? null
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

// ─── Confidence split — pricing vs. scope ──────────────────────────────────────
// "How reliable is this PRICE" (confidence_score, unchanged) answers a
// different question from "how reliable is this ESTIMATE overall" — a quote
// can have perfectly-priced line items while missing a whole trade or
// containing an internally-impossible quantity. Same colour thresholds as
// OverallConfidenceBadge (>=80 green, >=60 amber, else red) so a builder
// reads the two consistently, just labelled to show what each one means.

function confidenceColor(score: number): string {
  if (score >= 80) return 'var(--status-green)'
  if (score >= 60) return 'var(--status-amber)'
  return 'var(--status-red)'
}

function LabeledConfidenceBadge({ label, score }: { label: string; score: number }) {
  const color = confidenceColor(score)
  return (
    <span className="flex items-center gap-1.5" title={`${label}: ${score}%`}>
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} aria-hidden="true" />
      <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className="text-[12px] font-semibold" style={{ color }}>{score}%</span>
    </span>
  )
}

function ConfidenceSplit({ pricingConfidence, scopeConfidence, overallConfidence }: {
  pricingConfidence: number
  scopeConfidence: number | null | undefined
  overallConfidence: number | null | undefined
}) {
  if (scopeConfidence === null || scopeConfidence === undefined) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2" style={{ borderBottom: '1px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)' }}>
      <LabeledConfidenceBadge label="Pricing confidence" score={pricingConfidence} />
      <LabeledConfidenceBadge label="Scope confidence" score={scopeConfidence} />
      {overallConfidence !== null && overallConfidence !== undefined && (
        <LabeledConfidenceBadge label="Overall estimate confidence" score={overallConfidence} />
      )}
    </div>
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
  /** True when the quote is still editable (draft / pending_review). */
  canEdit?: boolean
  /** Set the builder's own price for an unpriced line. Resolves true on success. */
  onSetRate?: (itemId: string, rate: number) => Promise<boolean>
  /** Exclude an unpriced line from the quote. Resolves true on success. */
  onExclude?: (itemId: string) => Promise<boolean>
}

function LineItemRow({ item, canEdit, onSetRate, onExclude }: LineItemRowProps) {
  const isExcluded = item.assumption_status === 'excluded'
  const isUnresolved = item.is_assumption && item.assumption_status === 'unresolved'
  const isAllowance = item.pricing_type === 'pc_allowance' || item.pricing_type === 'provisional_sum'
  // Silently unpriced: included, contributes $0, and not already surfaced by
  // the assumption flow — mirrors isSilentlyUnpriced server-side.
  const isUnpriced = !isExcluded && !isUnresolved && item.total === null

  const [editing, setEditing] = useState(false)
  const [rateInput, setRateInput] = useState('')
  const [saving, setSaving] = useState(false)

  const submitRate = async () => {
    const rate = Number(rateInput)
    if (!onSetRate || !Number.isFinite(rate) || rate <= 0 || saving) return
    setSaving(true)
    const ok = await onSetRate(item.id, rate)
    setSaving(false)
    if (ok) setEditing(false)
  }

  const submitExclude = async () => {
    if (!onExclude || saving) return
    setSaving(true)
    await onExclude(item.id)
    setSaving(false)
  }

  // The one canonical sell-price calculation (lib/pricing.ts) — the same
  // function the quote summary API, PDF export, and invoice schedule now all
  // call too, so this row and the header total can no longer drift apart.
  const sellTotalExact = calculateSellTotal(item)
  const sellTotal = sellTotalExact !== null ? Math.round(sellTotalExact) : null

  return (
    <div
      className={['flex items-start gap-2 px-3 py-2.5 last:border-0', isExcluded ? 'opacity-60' : ''].filter(Boolean).join(' ')}
      style={{
        borderBottom: '1px solid var(--bg-border)',
        backgroundColor: isUnresolved ? 'rgba(244,67,54,0.06)' : isUnpriced ? 'rgba(255,152,0,0.06)' : undefined,
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
          {isUnpriced && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold"
              style={{ backgroundColor: 'rgba(255,152,0,0.1)', color: 'var(--status-amber)' }}
            >
              No price — adds $0
            </span>
          )}
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
        {!isExcluded && pricingSourceLabel(item.pricing_source) && (
          // Visible text, not a hover title — a tooltip never reaches a
          // builder on a phone, and "where did this number come from" is
          // exactly the question a touch-only user still needs answered.
          <span className="text-[11px] block mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
            {pricingSourceLabel(item.pricing_source)}
            {item.pricing_basis ? ` — ${item.pricing_basis}` : ''}
          </span>
        )}
        {/* Unpriced fix actions — the builder's way through the send gate */}
        {isUnpriced && canEdit && !editing && (
          <div className="flex items-center gap-2 mt-1.5">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-[11px] font-semibold px-2 py-1 rounded"
              style={{ backgroundColor: 'rgba(255,152,0,0.1)', color: 'var(--status-amber)' }}
            >
              Add your price
            </button>
            <button
              type="button"
              onClick={submitExclude}
              disabled={saving}
              className="text-[11px] font-medium px-2 py-1 rounded disabled:opacity-40"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Leave it out
            </button>
          </div>
        )}
        {isUnpriced && canEdit && editing && (
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              {item.quantity !== null && item.unit ? `$ per ${item.unit}` : '$ total for this item'}
            </span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              value={rateInput}
              onChange={(e) => setRateInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitRate() }}
              className="w-24 px-2 py-1 rounded text-[12px] tabular-nums"
              style={{ backgroundColor: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--bg-border)' }}
              aria-label={`Price for ${item.description}`}
              autoFocus
            />
            <button
              type="button"
              onClick={submitRate}
              disabled={saving || !(Number(rateInput) > 0)}
              className="btn-primary text-[11px] px-2.5 py-1 disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="text-[11px] px-2 py-1"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Cancel
            </button>
          </div>
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

      {/* Rate */}
      <div className="flex-shrink-0 text-right w-16 sm:w-20 hidden sm:block">
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

      {/* Confidence indicator */}
      <div className="hidden sm:flex flex-shrink-0 w-24 justify-end">
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
  canEdit?: boolean
  onSetRate?: (itemId: string, rate: number) => Promise<boolean>
  onExclude?: (itemId: string) => Promise<boolean>
}

function CategorySection({ group, isExpanded, onToggle, canEdit, onSetRate, onExclude }: CategorySectionProps) {
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
            <LineItemRow key={item.id} item={item} canEdit={canEdit} onSetRate={onSetRate} onExclude={onExclude} />
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
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            Client price
            <span className="ml-1.5 text-[11px] font-normal" style={{ color: 'var(--text-tertiary)' }}>
              ({summary.price_basis ?? 'excl. GST'})
            </span>
          </span>
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
            <span className="text-[11px] hidden sm:inline" style={{ color: 'var(--text-tertiary)' }}>{confidenceLabel}</span>
          </div>
        </div>
        <ConfidenceSplit
          pricingConfidence={summary.confidence_score}
          scopeConfidence={summary.scope_confidence}
          overallConfidence={summary.overall_estimate_confidence}
        />
        {/* Readiness banner — the one answer to "can I send this?" */}
        {summary.readiness === 'blocked' && (
          <div className="px-4 py-2.5" style={{ backgroundColor: 'rgba(244,67,54,0.08)' }}>
            <div className="flex items-center gap-2">
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
                These items require review before sending
              </span>
            </div>
            <ul className="mt-1 ml-6 space-y-0.5">
              {summary.blocked_reasons.map((reason, i) => (
                <li key={i} className="text-[12px]" style={{ color: 'var(--status-red)' }}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
        {summary.readiness === 'review_required' && (
          <div className="px-4 py-2.5" style={{ backgroundColor: 'rgba(255,152,0,0.1)' }}>
            <div className="flex items-center gap-2">
              <svg
                className="w-4 h-4 flex-shrink-0"
                style={{ color: 'var(--status-amber)' }}
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
              <span className="text-[13px] font-medium" style={{ color: 'var(--status-amber)' }}>
                The numbers are complete — check the items below before sending
              </span>
            </div>
            {summary.review_reasons.length > 0 && (
              <ul className="mt-1 ml-6 space-y-0.5">
                {summary.review_reasons.map((reason, i) => (
                  <li key={i} className="text-[12px]" style={{ color: 'var(--status-amber)' }}>{reason}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {summary.readiness === 'ready' && (
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
            <div className="min-w-0">
              <span className="text-[13px] font-medium" style={{ color: 'var(--status-green)' }}>
                Quote is ready to send
              </span>
              {/* "Ready" means no known blocking issues remain — not a
                  guarantee the estimate is perfect. Stated explicitly so a
                  builder doesn't read this pill as more certainty than
                  WorkA can actually promise. */}
              <span className="block text-[11px]" style={{ color: 'var(--status-green)', opacity: 0.75 }}>
                No known blocking issues remain — review the numbers below before you send.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── "WorkA assumed" — conservative assumptions made in place of an unanswered
// blocking clarifying question (see assumptions.gate IS NULL, migration 066).
// The estimate never waits on these — this is where they're disclosed so the
// builder can see exactly what to check, and answering the question in chat
// resolves the row automatically on the next pipeline run.

function AssumptionsMade({ assumptions }: { assumptions: CriticalAssumption[] }) {
  const unresolved = assumptions.filter((a) => !a.resolved)
  if (unresolved.length === 0) return null

  return (
    <div className="mx-4 mb-4 rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,152,0,0.3)' }}>
      <div className="px-4 py-2" style={{ backgroundColor: 'rgba(255,152,0,0.08)', borderBottom: '1px solid rgba(255,152,0,0.2)' }}>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--status-amber)' }}>
          WorkA assumed these
        </h3>
        <p className="text-[11px] mt-0.5" style={{ color: 'var(--status-amber)' }}>
          Couldn&apos;t be confirmed from your documents — estimated with a conservative default so you get a number now. Answer in chat to replace the assumption.
        </p>
      </div>
      <div style={{ backgroundColor: 'var(--bg-surface)' }}>
        {unresolved.map((a) => (
          <div key={a.id} className="px-4 py-2.5" style={{ borderBottom: '1px solid var(--bg-border)' }}>
            <div className="flex items-start justify-between gap-2">
              <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{a.question}</span>
              <span className="flex-shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--status-amber)' }}>
                -{a.confidence_penalty} confidence
              </span>
            </div>
            <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
              Assumed: <span style={{ color: 'var(--text-primary)' }}>{a.assumed_value}</span>
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{a.reason}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── "What WorkA read" — per-document contribution, on screen ────────────────
// Answers the builder's real question — "I uploaded my plans. Did WorkA
// actually use them?" — with the engine's own per-document accounting
// (quotes.document_contribution, migration 039) instead of asking them to
// trust a progress bar they watched an hour ago.

function WhatWorkaRead({ contribution }: { contribution: DocumentContributionPayload }) {
  const docs = contribution.documents ?? []
  const notProcessed = [...(contribution.excluded ?? []), ...(contribution.failed ?? [])]
  if (docs.length === 0 && notProcessed.length === 0) return null

  return (
    <div className="mx-4 mb-4 rounded-xl overflow-hidden" style={{ border: '1px solid var(--bg-border)' }}>
      <div className="px-4 py-2" style={{ backgroundColor: 'var(--bg-elevated)', borderBottom: '1px solid var(--bg-border)' }}>
        <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
          What WorkA read
        </h3>
        <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
          Every document, and how much of it shaped this estimate.
        </p>
      </div>
      <div style={{ backgroundColor: 'var(--bg-surface)' }}>
        {docs.map((d) => {
          const unused = d.facts_used === 0
          return (
            <div key={d.document_id} className="flex items-center justify-between gap-2 px-4 py-2" style={{ borderBottom: '1px solid var(--bg-border)' }}>
              <div className="flex items-center gap-2 min-w-0">
                {unused ? (
                  <span className="flex-shrink-0 font-semibold" style={{ color: 'var(--status-red)' }} aria-hidden="true">✕</span>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="flex-shrink-0">
                    <path d="M2 6l2.5 2.5L10 3" stroke="var(--status-green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                <span className="text-[13px] truncate" style={{ color: unused ? 'var(--status-red)' : 'var(--text-primary)' }}>{d.name}</span>
              </div>
              <span className="text-[11px] flex-shrink-0 tabular-nums" style={{ color: unused ? 'var(--status-red)' : 'var(--text-tertiary)' }}>
                {unused ? 'nothing usable read' : `${d.facts_used} of ${d.facts_extracted} detail${d.facts_extracted !== 1 ? 's' : ''} used`}
              </span>
            </div>
          )
        })}
        {contribution.other_sources && contribution.other_sources.facts_extracted > 0 && (
          <div className="flex items-center justify-between gap-2 px-4 py-2" style={{ borderBottom: '1px solid var(--bg-border)' }}>
            <div className="flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="flex-shrink-0">
                <path d="M2 6l2.5 2.5L10 3" stroke="var(--status-green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>Your answers</span>
            </div>
            <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
              {contribution.other_sources.facts_used} of {contribution.other_sources.facts_extracted} used
            </span>
          </div>
        )}
        {notProcessed.map((name, i) => (
          <div key={`np-${i}`} className="flex items-center justify-between gap-2 px-4 py-2" style={{ borderBottom: '1px solid var(--bg-border)', backgroundColor: 'rgba(244,67,54,0.06)' }}>
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex-shrink-0 font-semibold" style={{ color: 'var(--status-red)' }} aria-hidden="true">✕</span>
              <span className="text-[13px] truncate" style={{ color: 'var(--status-red)' }}>{name}</span>
            </div>
            <span className="text-[11px] flex-shrink-0" style={{ color: 'var(--status-red)' }}>not processed — scope missing</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Estimate coverage / confidence banner ────────────────────────────────────
//
// "A builder must never see a normal-looking estimate without knowing the
// level of document coverage behind it." Backed by estimate_runs.builder_status
// (migrations 078-079) via GET /api/jobs/[jobId]/estimate-status — the SAME
// three-tier outcome the 15-minute SLA watchdog finalizes runs into. Rendered
// as the very first thing in the quote body, above the summary card, so it
// can't be missed the way the QA panel further down can be.

export interface CoverageDocument {
  file_id: string
  filename: string
  document_type?: string | null
  status?: 'failed' | 'pending'
}

export interface EstimateStatusPayload {
  has_run: boolean
  builder_status: 'ESTIMATE_READY' | 'ESTIMATE_READY_WITH_WARNINGS' | 'NEEDS_REVIEW' | null
  needs_review_reason: string | null
  needs_review_reason_code: string | null
  coverage: {
    documents_uploaded: number
    documents_analyzed: number
    documents_failed_or_pending: number
    coverage_percentage: number
    confidence_level: 'high' | 'medium' | 'low'
    contributing_documents: CoverageDocument[]
    missing_documents: CoverageDocument[]
  } | null
}

const COVERAGE_BANNER_STYLE: Record<'ready' | 'warning' | 'review', { border: string; bg: string; text: string; headline: string }> = {
  ready: {
    border: '1px solid rgba(76,175,80,0.3)',
    bg: 'rgba(76,175,80,0.08)',
    text: 'var(--status-green)',
    headline: 'Estimate generated from complete project documentation.',
  },
  warning: {
    border: '1px solid rgba(255,152,0,0.3)',
    bg: 'rgba(255,152,0,0.08)',
    text: 'var(--status-amber)',
    headline: 'Estimate generated with partial documentation. Review missing items before sending.',
  },
  review: {
    border: '1px solid rgba(244,67,54,0.3)',
    bg: 'rgba(244,67,54,0.08)',
    text: 'var(--status-red)',
    headline: 'Estimate requires review. Important project documents were not available for analysis.',
  },
}

function EstimateCoverageBanner({ status }: { status: EstimateStatusPayload }) {
  if (!status.has_run || !status.builder_status || !status.coverage) return null

  const tier = status.builder_status === 'ESTIMATE_READY'
    ? 'ready'
    : status.builder_status === 'ESTIMATE_READY_WITH_WARNINGS'
    ? 'warning'
    : 'review'
  const style = COVERAGE_BANNER_STYLE[tier]
  const { documents_analyzed, documents_uploaded, coverage_percentage, contributing_documents, missing_documents } = status.coverage

  // A fully-covered, fully-ready estimate doesn't need its own document
  // checklist repeated here — WhatWorkaRead (per-document fact usage)
  // already covers that level of detail once everything went well. The
  // banner only expands into a checklist when there's something to flag.
  const showChecklist = tier !== 'ready' && (contributing_documents.length > 0 || missing_documents.length > 0)

  return (
    <div className="mx-4 mb-4 rounded-xl overflow-hidden" style={{ border: style.border }}>
      <div className="px-4 py-3" style={{ backgroundColor: style.bg }}>
        <p className="text-[13px] font-semibold" style={{ color: style.text }}>{style.headline}</p>
        <p className="text-[12px] mt-1" style={{ color: style.text }}>
          Document coverage: {documents_analyzed} of {documents_uploaded} document{documents_uploaded === 1 ? '' : 's'} analysed ({coverage_percentage}%)
        </p>
      </div>
      {showChecklist && (
        <div className="px-4 py-3 space-y-2" style={{ backgroundColor: 'var(--bg-surface)', borderTop: `1px solid ${style.border.split(' ').pop()}` }}>
          {contributing_documents.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--text-tertiary)' }}>Included</p>
              <ul className="space-y-0.5">
                {contributing_documents.map((d) => (
                  <li key={d.file_id} className="text-[12px] flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                    <span style={{ color: 'var(--status-green)' }} aria-hidden="true">✓</span> {d.filename}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {missing_documents.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--text-tertiary)' }}>Not analysed</p>
              <ul className="space-y-0.5">
                {missing_documents.map((d) => (
                  <li key={d.file_id} className="text-[12px] flex items-center gap-1.5" style={{ color: style.text }}>
                    <span aria-hidden="true">⚠</span> {d.filename}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {status.needs_review_reason && tier !== 'ready' && (
        <div className="px-4 py-2" style={{ backgroundColor: 'var(--bg-surface)', borderTop: '1px solid var(--bg-border)' }}>
          <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{status.needs_review_reason}</p>
        </div>
      )}
    </div>
  )
}

// ─── Construction sanity checklist — "Before sending this quote, N things
// to check", each with What WorkA noticed / Why it matters / Your action.
// lib/estimating/qa.ts also folds a condensed one-line version of each of
// these findings into report.top_risks/review_items (so they still drive
// the readiness/blocked-vs-review_required state via the existing
// send-gate plumbing) — CheckBeforeSending below filters those exact lines
// back out of the generic lists so nothing renders twice.

function ConstructionSanityChecklist({ findings }: { findings: ConstructionSanityFindingPayload[] }) {
  if (findings.length === 0) return null
  return (
    <div className="mx-4 mb-4 rounded-xl overflow-hidden" style={{ border: '1px solid var(--bg-border)' }}>
      <div className="px-4 py-2.5" style={{ backgroundColor: 'var(--bg-elevated)', borderBottom: '1px solid var(--bg-border)' }}>
        <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          Before sending this quote — {findings.length} thing{findings.length === 1 ? '' : 's'} to check
        </h3>
      </div>
      <div style={{ backgroundColor: 'var(--bg-surface)' }}>
        {findings.map((f) => (
          <div key={f.id} className="px-4 py-3" style={{ borderBottom: '1px solid var(--bg-border)' }}>
            <p className="text-[13px] font-semibold flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
              <span aria-hidden="true">{f.severity === 'red' ? '🔴' : '🟡'}</span> {f.summary}
            </p>
            <dl className="mt-1.5 space-y-1">
              <div className="text-[12px]">
                <dt className="inline font-medium" style={{ color: 'var(--text-tertiary)' }}>What WorkA noticed: </dt>
                <dd className="inline" style={{ color: 'var(--text-secondary)' }}>{f.what_noticed}</dd>
              </div>
              <div className="text-[12px]">
                <dt className="inline font-medium" style={{ color: 'var(--text-tertiary)' }}>Why it matters: </dt>
                <dd className="inline" style={{ color: 'var(--text-secondary)' }}>{f.why_it_matters}</dd>
              </div>
              <div className="text-[12px]">
                <dt className="inline font-medium" style={{ color: 'var(--text-tertiary)' }}>Your action: </dt>
                <dd className="inline" style={{ color: 'var(--text-secondary)' }}>{f.builder_action}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Construction coverage summary — "why is this estimate lower than
// expected," visible before any price is discussed. Always shown when the
// data exists (not just when something looks wrong) — the point is
// transparency about what was checked, not only what failed.

function ConstructionCoverageSummary({ coverage }: { coverage: NonNullable<QAReportPayload['construction_coverage']> }) {
  const hasGap = coverage.missing_trade_ids.length > 0 || coverage.detected_trade_count < coverage.expected_trade_count
  return (
    <div className="mx-4 mb-4 rounded-xl overflow-hidden" style={{ border: '1px solid var(--bg-border)' }}>
      <div className="px-4 py-2.5 flex items-center justify-between" style={{ backgroundColor: 'var(--bg-elevated)' }}>
        <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>Construction coverage</span>
        <span className="text-[12px] font-semibold" style={{ color: hasGap ? 'var(--status-amber)' : 'var(--status-green)' }}>
          {coverage.detected_trade_count} of {coverage.expected_trade_count} expected trade{coverage.expected_trade_count === 1 ? '' : 's'} detected
        </span>
      </div>
      {coverage.missing_trade_names.length > 0 && (
        <div className="px-4 py-2" style={{ backgroundColor: 'var(--bg-surface)' }}>
          <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            Missing: {coverage.missing_trade_names.join(', ')}
          </span>
        </div>
      )}
      {coverage.detected_characteristics.length > 0 && (
        <div className="px-4 py-2" style={{ backgroundColor: 'var(--bg-surface)', borderTop: coverage.missing_trade_names.length > 0 ? '1px solid var(--bg-border)' : undefined }}>
          <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            Detected project characteristics: {coverage.detected_characteristics.join(', ').replace(/_/g, ' ')}
          </span>
        </div>
      )}
    </div>
  )
}

// ─── "Check before sending" — the QA report, finally on screen ───────────────

function CheckBeforeSending({ report }: { report: QAReportPayload }) {
  const sanityFindings = report.construction_sanity_findings ?? []
  // The exact condensed strings qa.ts folded into top_risks/review_items for
  // each construction-sanity finding — filtered back out here so the
  // structured checklist above is the only place they render.
  const sanityLines = new Set(sanityFindings.map((f) => `${f.what_noticed} ${f.builder_action}`))
  const topRisks = report.top_risks.filter((r) => !sanityLines.has(r))
  const reviewItems = report.review_items.filter((r) => !sanityLines.has(r))
  const hasGenericContent = topRisks.length > 0 || reviewItems.length > 0

  return (
    <>
      {report.construction_coverage && <ConstructionCoverageSummary coverage={report.construction_coverage} />}
      <ConstructionSanityChecklist findings={sanityFindings} />
      {hasGenericContent && (
        <div className="mx-4 mb-4 rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,152,0,0.3)' }}>
          <div className="px-4 py-2" style={{ backgroundColor: 'rgba(255,152,0,0.08)', borderBottom: '1px solid rgba(255,152,0,0.2)' }}>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--status-amber)' }}>
              Check before sending
            </h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--status-amber)' }}>
              WorkA reviewed this estimate — these are the things only you can confirm.
            </p>
          </div>
          <div style={{ backgroundColor: 'var(--bg-surface)' }}>
            {topRisks.map((risk, i) => (
              <div key={`risk-${i}`} className="flex items-start gap-2 px-4 py-2" style={{ borderBottom: '1px solid var(--bg-border)' }}>
                <span className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" style={{ backgroundColor: 'var(--status-red)' }} aria-hidden="true" />
                <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{risk}</span>
              </div>
            ))}
            {reviewItems.map((item, i) => (
              <div key={`review-${i}`} className="flex items-start gap-2 px-4 py-2" style={{ borderBottom: '1px solid var(--bg-border)' }}>
                <span className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" style={{ backgroundColor: 'var(--status-amber)' }} aria-hidden="true" />
                <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>{item}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
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
    <div
      className="flex-shrink-0 px-4 py-3"
      style={{ borderTop: '1px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)' }}
    >
      {!summary.can_send && (
        <p className="text-[13px] font-medium mb-2 flex items-center gap-1.5" style={{ color: 'var(--status-red)' }}>
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
          These items require review before sending
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSend(quoteId)}
          disabled={!summary.can_send}
          title={
            summary.can_send
              ? summary.readiness === 'review_required'
                ? 'Check the flagged items, then send'
                : 'Send quote to client'
              : summary.blocked_reasons[0] ?? 'Fix the flagged items first'
          }
          className="btn-primary px-4 py-2 text-[13px] disabled:opacity-40 disabled:cursor-not-allowed flex-1 sm:flex-none"
        >
          Send to client
        </button>
        <button
          type="button"
          onClick={() => onExportPdf(quoteId)}
          className="btn-secondary px-4 py-2 text-[13px] flex-1 sm:flex-none"
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
  const [estimateStatus, setEstimateStatus] = useState<EstimateStatusPayload | null>(null)

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

  // Fetch quote data. Extracted so the line-item fix actions can re-fetch
  // after a successful PATCH — the server recomputes totals/QA/readiness,
  // and the screen must show that truth rather than a local guess.
  const firstLoadRef = useRef(true)
  const loadQuote = useCallback(async () => {
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
      // Financial reconciliation invariant: the sum of what every line item
      // row below displays must equal the header total above it — both are
      // now computed by the same canonical calculateClientPrice (lib/
      // pricing.ts), so a mismatch here means something bypassed it, not a
      // rounding quirk. Dev-visible only (console), never blocks rendering —
      // the QA report's own FINANCIAL_RECONCILIATION_FAILED check is the
      // builder-facing enforcement before a quote can be sent.
      if (process.env.NODE_ENV !== 'production') {
        const allLineItems = json.line_items_by_category.flatMap((g) => g.items)
        const recomputedClientPrice = calculateClientPrice(allLineItems)
        const drift = Math.abs(recomputedClientPrice - json.summary.client_price)
        if (drift > 1) {
          console.warn(
            `[QuoteView] financial reconciliation mismatch: sum of line item sell totals ($${recomputedClientPrice}) does not match summary.client_price ($${json.summary.client_price}), drift=$${drift.toFixed(2)}`
          )
        }
      }
      // Expand all categories by default — but only on first load, so a
      // refetch after a fix doesn't blow away the builder's collapse state.
      if (firstLoadRef.current) {
        firstLoadRef.current = false
        const allIds = new Set(json.line_items_by_category.map((g) => g.category_id))
        setExpandedCategories(allIds)
      }
    } catch {
      setError('Something went wrong loading the quote.')
    } finally {
      setIsLoading(false)
    }
  }, [quoteId])

  useEffect(() => {
    loadQuote()
  }, [loadQuote])

  // Coverage/confidence banner data — fetched independently of the quote
  // itself once we know the job_id, so a failure here never blocks the
  // quote from rendering (best-effort, same posture as the QA lazy-run
  // above). Not re-fetched on every loadQuote() call (a line-item PATCH
  // doesn't change document coverage), only once per quote.
  useEffect(() => {
    const jobId = data?.quote.job_id
    if (!jobId) return
    let cancelled = false
    fetch(`/api/jobs/${jobId}/estimate-status`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: EstimateStatusPayload | null) => {
        if (!cancelled && json) setEstimateStatus(json)
      })
      .catch(() => { /* best-effort — the quote itself still renders fine */ })
    return () => { cancelled = true }
  }, [data?.quote.job_id])

  // Line-item fix actions — the builder's way through the unpriced gate.
  const patchLineItem = useCallback(async (itemId: string, body: { rate?: number; excluded?: boolean }): Promise<boolean> => {
    try {
      const res = await fetch(`/api/quotes/${quoteId}/line-items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) return false
      await loadQuote()
      return true
    } catch {
      return false
    }
  }, [quoteId, loadQuote])

  const handleSetRate = useCallback((itemId: string, rate: number) => patchLineItem(itemId, { rate }), [patchLineItem])
  const handleExclude = useCallback((itemId: string) => patchLineItem(itemId, { excluded: true }), [patchLineItem])

  const canEditItems = !!data && !sentAt && ['draft', 'pending_review'].includes(data.quote.status)

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
              {/* Document coverage / confidence — must be the first thing a
                  builder sees, not buried below the numbers. */}
              {estimateStatus && <EstimateCoverageBanner status={estimateStatus} />}

              {/* Summary card */}
              <SummaryCard summary={data.summary} />

              {/* What did WorkA assume in place of an unanswered blocking question? */}
              {data.summary.critical_assumptions && data.summary.critical_assumptions.length > 0 && (
                <AssumptionsMade assumptions={data.summary.critical_assumptions} />
              )}

              {/* What should I check? — QA output, shown before the numbers */}
              {data.qa_report && <CheckBeforeSending report={data.qa_report} />}

              {/* Did WorkA actually use my documents? */}
              {data.document_contribution && <WhatWorkaRead contribution={data.document_contribution} />}

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
                  canEdit={canEditItems}
                  onSetRate={handleSetRate}
                  onExclude={handleExclude}
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
