'use client'
import React, { useMemo, useState } from 'react'
import IndicativeBanner from './IndicativeBanner'
import type {
  GeneratedEstimate,
  EstimateSectionGroup,
  EstimateLineItem,
  EstimateBasis,
  GuardWarning,
  RateMatchSummary,
} from '@/lib/estimate-generation'

// ─── EstimateView ─────────────────────────────────────────────────────────────
// The reasoned line-item estimate: guard warnings up top, sectioned line items
// with basis + source ref per line, and the visible contingency/margin/GST
// roll-up. When indicative, the budget-range banner sits on top.

interface Props {
  estimate: GeneratedEstimate
}

const aud = (n: number) =>
  n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 })

const BASIS_LABEL: Record<EstimateBasis, string> = {
  measured: 'Measured',
  allowance: 'Allowance',
  pc_sum: 'PC Sum',
  provisional: 'Provisional',
}
function basisStyle(b: EstimateBasis): React.CSSProperties {
  if (b === 'measured') return { background: 'rgba(76,175,80,0.15)', color: 'var(--status-green)' }
  if (b === 'allowance') return { background: 'rgba(33,150,243,0.1)', color: 'var(--status-blue)' }
  if (b === 'pc_sum') return { background: 'rgba(255,152,0,0.1)', color: 'var(--status-amber)' }
  return { background: 'rgba(244,67,54,0.1)', color: 'var(--status-red)' } // provisional
}

const LOCATION_LABEL: Record<string, string> = {
  primary: 'Primary',
  secondary_dwelling: 'Secondary dwelling',
  pool: 'Pool',
  external: 'External',
  general: 'General',
}

const card: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--bg-border)',
  borderRadius: 16,
  padding: 20,
}
const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
}

export default function EstimateView({ estimate }: Props) {
  const { totals } = estimate
  const provisionalCount = useMemo(
    () => estimate.sections.flatMap((s) => s.items).filter((i) => i.basis === 'provisional').length,
    [estimate]
  )

  return (
    <div className="grid gap-4">
      {estimate.is_indicative && (
        <IndicativeBanner reason="Not tender-ready — structural, spec and finish-selection gaps remain. Firm pricing requires those resolved." />
      )}

      {/* Guard warnings */}
      {estimate.guard_warnings.length > 0 && (
        <div className="grid gap-2">
          {estimate.guard_warnings.map((w, i) => (
            <GuardRow key={i} warning={w} />
          ))}
        </div>
      )}

      {/* Rate-library coverage (user-supplied mode) */}
      {estimate.pricing_mode === 'user_supplied' && estimate.rate_match && (
        <RateMatchSummaryRow match={estimate.rate_match} />
      )}

      {/* Headline totals */}
      <section style={{ ...card, border: '1px solid var(--orange-subtle)' }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p style={sectionLabel}>Estimated total (inc GST)</p>
            <p className="text-4xl font-bold tabular-nums mt-1" style={{ color: 'var(--text-primary)' }}>
              {aud(totals.total_inc_gst)}
            </p>
            <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
              {estimate.line_count} line items · {estimate.sections.length} sections ·{' '}
              {estimate.pricing_mode === 'user_supplied' ? 'your rate library' : 'market rates (indicative)'}
            </p>
          </div>
        </div>

        {/* Roll-up — contingency / margin / GST always visible, never buried */}
        <div className="grid gap-2 mt-4">
          <TotalRow label="Trade subtotal (cost)" value={totals.trade_subtotal} />
          <TotalRow label={`Contingency (${totals.contingency_pct}%)`} value={totals.contingency_amount} sub="scaled to DA-stage documentation" />
          <TotalRow label={`Margin (${totals.margin_pct}%)`} value={totals.margin_amount} />
          <TotalRow label="Total ex GST" value={totals.total_ex_gst} strong />
          <TotalRow label={`GST (${totals.gst_pct}%)`} value={totals.gst_amount} />
          <TotalRow label="Total inc GST" value={totals.total_inc_gst} strong />
        </div>

        {provisionalCount > 0 && (
          <p className="text-xs mt-3" style={{ color: 'var(--text-tertiary)' }}>
            {provisionalCount} line{provisionalCount !== 1 ? 's' : ''} carried as provisional sums (structural / specialist
            scope pending confirmation) — no specific engineering figures were invented.
          </p>
        )}
        {estimate.confidence_summary && (
          <p className="text-xs mt-2" style={{ color: 'var(--text-secondary)', lineHeight: 1.45 }}>
            {estimate.confidence_summary}
          </p>
        )}
      </section>

      {/* Sections */}
      {estimate.sections.map((s) => (
        <SectionBlock key={s.key} section={s} />
      ))}
    </div>
  )
}

// ── sub-components ───────────────────────────────────────────────────────────

function SectionBlock({ section }: { section: EstimateSectionGroup; key?: React.Key }) {
  const [open, setOpen] = useState(true)
  return (
    <section style={card}>
      <button onClick={() => setOpen((o: boolean) => !o)} className="w-full flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <svg
            className="flex-shrink-0"
            style={{ width: 14, height: 14, color: 'var(--text-tertiary)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{section.label}</span>
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>({section.items.length})</span>
        </div>
        <span className="text-sm font-semibold tabular-nums flex-shrink-0" style={{ color: 'var(--text-primary)' }}>
          {aud(section.subtotal)}
        </span>
      </button>

      {open && (
        <div className="mt-3 grid gap-1.5">
          {section.items.map((it, i) => (
            <LineItemRow key={i} item={it} />
          ))}
        </div>
      )}
    </section>
  )
}

function LineItemRow({ item }: { item: EstimateLineItem; key?: React.Key }) {
  const qtyLabel =
    item.quantity !== null && item.unit ? `${item.quantity.toLocaleString('en-AU')} ${item.unit}` : item.unit ?? ''
  return (
    <div className="rounded-lg px-3 py-2.5" style={{ background: 'var(--bg-elevated)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase" style={basisStyle(item.basis)}>
              {BASIS_LABEL[item.basis]}
            </span>
            {item.location_scope !== 'primary' && item.location_scope !== 'general' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-tertiary)' }}>
                {LOCATION_LABEL[item.location_scope]}
              </span>
            )}
            {item.rate_unmatched && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase" style={{ background: 'rgba(255,152,0,0.1)', color: 'var(--status-amber)', border: '0.5px solid var(--status-amber)' }}>
                Not in your library
              </span>
            )}
          </div>
          <p className="text-sm mt-1" style={{ color: 'var(--text-primary)', lineHeight: 1.4 }}>{item.description}</p>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1">
            {qtyLabel && <span className="text-xs tabular-nums" style={{ color: 'var(--text-tertiary)' }}>{qtyLabel}</span>}
            {item.rate !== null && (
              <span className="text-xs tabular-nums" style={{ color: 'var(--text-tertiary)' }}>@ {aud(item.rate)}</span>
            )}
            {item.source_ref && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(33,150,243,0.08)', color: 'var(--status-blue)', border: '0.5px solid rgba(33,150,243,0.2)' }}
              >
                {item.source_ref}
              </span>
            )}
          </div>
          {item.notes && <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)', lineHeight: 1.4 }}>{item.notes}</p>}
        </div>
        <span className="text-sm font-semibold tabular-nums flex-shrink-0" style={{ color: 'var(--text-primary)' }}>
          {item.total !== null ? aud(item.total) : '—'}
        </span>
      </div>
    </div>
  )
}

function TotalRow({ label, value, sub, strong }: { label: string; value: number; sub?: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <span className="text-sm" style={{ color: strong ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: strong ? 600 : 400 }}>
          {label}
        </span>
        {sub && <span className="text-xs ml-2" style={{ color: 'var(--text-tertiary)' }}>{sub}</span>}
      </div>
      <span className="text-sm tabular-nums" style={{ color: 'var(--text-primary)', fontWeight: strong ? 700 : 500 }}>
        {aud(value)}
      </span>
    </div>
  )
}

function RateMatchSummaryRow({ match }: { match: RateMatchSummary }) {
  const total = match.matched + match.unmatched
  const pct = total > 0 ? Math.round((match.matched / total) * 100) : 0
  const hasUnmatched = match.unmatched > 0
  return (
    <section style={{ ...card }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p style={sectionLabel}>Your rate library</p>
          <p className="text-sm mt-1" style={{ color: 'var(--text-primary)' }}>
            {match.matched} of {total} priceable lines matched ({pct}%)
          </p>
        </div>
        {hasUnmatched && (
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: 'rgba(255,152,0,0.1)', color: 'var(--status-amber)', border: '1px solid var(--status-amber)' }}>
            {match.unmatched} unmatched — priced at market, flagged
          </span>
        )}
      </div>
      {hasUnmatched && (
        <div className="mt-3 grid gap-1">
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            These weren&rsquo;t in your library — they fall back to market rates and are flagged, never silently substituted:
          </p>
          {match.unmatched_items.slice(0, 12).map((u, i) => (
            <p key={i} className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              • {u.description}{u.source_ref ? ` (${u.source_ref})` : ''}
            </p>
          ))}
          {match.unmatched_items.length > 12 && (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              …and {match.unmatched_items.length - 12} more.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function GuardRow({ warning }: { warning: GuardWarning; key?: React.Key }) {
  const block = warning.severity === 'block'
  return (
    <div
      className="rounded-xl px-4 py-3 flex items-start gap-3"
      style={{
        background: block ? 'rgba(244,67,54,0.08)' : 'rgba(255,152,0,0.1)',
        border: `1px solid ${block ? 'rgba(244,67,54,0.3)' : 'var(--status-amber)'}`,
      }}
    >
      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase flex-shrink-0 mt-0.5" style={{ background: block ? 'rgba(244,67,54,0.15)' : 'rgba(255,152,0,0.2)', color: block ? 'var(--status-red)' : 'var(--status-amber)' }}>
        {block ? 'Guard' : 'Check'}
      </span>
      <div className="min-w-0">
        <p className="text-sm" style={{ color: 'var(--text-secondary)', lineHeight: 1.45 }}>{warning.message}</p>
        {warning.refs && warning.refs.length > 0 && (
          <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>{warning.refs.join(', ')}</p>
        )}
      </div>
    </div>
  )
}
