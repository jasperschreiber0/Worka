'use client'
import React, { useState } from 'react'
import Link from 'next/link'
import type { EstimateResult, EstimateTradeLine, EstimateComparable } from '@/lib/estimation-engine'
import type { TradeExplainability } from '@/lib/types/estimation.types'
import ExplainabilityCard from '@/components/estimation/ExplainabilityCard'

// Adapts the parametric estimator's per-trade breakdown into the shape
// ExplainabilityCard expects. Confidence and key drivers are the overall
// estimate's — there's no per-trade breakdown of those yet — and the
// similar-project range is each trade's share of the overall low/high band.
function toExplainability(result: EstimateResult): TradeExplainability[] {
  return result.per_trade.map((t: EstimateTradeLine) => ({
    trade_category_id: t.trade_category_id,
    trade_category_name: t.name,
    estimated_cost: t.amount,
    confidence: result.confidence,
    similar_project_range:
      result.range_low > 0
        ? `${aud(Math.round(result.range_low * t.pct))}–${aud(Math.round(result.range_high * t.pct))} across ${result.comparable_count} similar project${result.comparable_count !== 1 ? 's' : ''}`
        : null,
    historical_accuracy: null,
    key_drivers: result.drivers,
  }))
}

// ─── Options ──────────────────────────────────────────────────────────────────

const JOB_TYPES: Array<{ v: string; l: string }> = [
  { v: 'rear_extension', l: 'Rear extension' },
  { v: 'side_extension', l: 'Side extension' },
  { v: 'double_storey', l: 'Double-storey addition' },
  { v: 'full_renovation', l: 'Full renovation' },
  { v: 'kitchen_reno', l: 'Kitchen renovation' },
  { v: 'bathroom_reno', l: 'Bathroom renovation' },
  { v: 'granny_flat', l: 'Granny flat' },
  { v: 'new_build', l: 'New build' },
  { v: 'knockdown_rebuild', l: 'Knockdown rebuild' },
  { v: 'deck_pergola', l: 'Deck / pergola' },
  { v: 'other', l: 'Other' },
]
const FINISHES = ['budget', 'standard', 'premium', 'luxury']
const REGIONS = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT']

const aud = (n: number) =>
  n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 })

// ─── Component ────────────────────────────────────────────────────────────────

export default function EstimatePage() {
  const [jobType, setJobType] = useState('rear_extension')
  const [area, setArea] = useState('95')
  const [finish, setFinish] = useState('premium')
  const [region, setRegion] = useState('VIC')
  const [storeys, setStoreys] = useState('1')
  const [wetAreas, setWetAreas] = useState('1')

  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<EstimateResult | null>(null)
  const [totalInMemory, setTotalInMemory] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runEstimate() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/estimation/quick-estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_metadata: {
            job_type: jobType,
            floor_area_m2: area ? Number(area) : null,
            finish_level: finish,
            region,
            storeys: storeys ? Number(storeys) : null,
            wet_areas: wetAreas ? Number(wetAreas) : null,
          },
        }),
      })
      const data = (await res.json()) as { estimate?: EstimateResult; total_in_memory?: number; error?: string }
      if (!res.ok || !data.estimate) {
        setError(data.error ?? 'Could not estimate. Please try again.')
        setResult(null)
        return
      }
      setResult(data.estimate)
      setTotalInMemory(data.total_in_memory ?? null)
    } catch {
      setError('Could not estimate. Please try again.')
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  const confColor = (c: number) =>
    c >= 75 ? 'var(--status-green)' : c >= 50 ? 'var(--status-amber)' : 'var(--status-red)'

  const maxTrade = result ? Math.max(...result.per_trade.map((t: EstimateTradeLine) => t.amount), 1) : 1

  const fieldStyle: React.CSSProperties = {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--bg-border)',
    color: 'var(--text-primary)',
    borderRadius: 10,
    padding: '9px 11px',
    fontSize: 14,
    width: '100%',
  }
  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '.05em',
    textTransform: 'uppercase',
    color: 'var(--text-tertiary)',
    marginBottom: 6,
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-shell)' }}>
      <header style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--bg-border)' }}>
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link href="/chat" className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Chat
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Instant estimate</h1>
          <p className="mt-1.5" style={{ color: 'var(--text-secondary)' }}>
            A ballpark from your own history — grounded in the jobs you&rsquo;ve actually delivered, with the working shown.
          </p>
          <Link href="/estimate/history" className="inline-flex items-center gap-1 text-sm font-medium mt-2" style={{ color: 'var(--orange-primary)' }}>
            Add past jobs to sharpen this
            <span aria-hidden="true">→</span>
          </Link>
        </div>

        {/* ── Input form ─────────────────────────────────────────────── */}
        <section
          className="rounded-2xl p-5 mb-6"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)' }}
        >
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Job type</label>
              <select value={jobType} onChange={(e) => setJobType(e.target.value)} style={fieldStyle}>
                {JOB_TYPES.map((j) => <option key={j.v} value={j.v}>{j.l}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Floor area (m²)</label>
              <input type="number" inputMode="numeric" value={area} onChange={(e) => setArea(e.target.value)} style={fieldStyle} />
            </div>
            <div>
              <label style={labelStyle}>Finish level</label>
              <select value={finish} onChange={(e) => setFinish(e.target.value)} style={fieldStyle}>
                {FINISHES.map((f) => <option key={f} value={f}>{f[0].toUpperCase() + f.slice(1)}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>State</label>
              <select value={region} onChange={(e) => setRegion(e.target.value)} style={fieldStyle}>
                {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Storeys</label>
              <input type="number" inputMode="numeric" value={storeys} onChange={(e) => setStoreys(e.target.value)} style={fieldStyle} />
            </div>
            <div>
              <label style={labelStyle}>Wet areas</label>
              <input type="number" inputMode="numeric" value={wetAreas} onChange={(e) => setWetAreas(e.target.value)} style={fieldStyle} />
            </div>
          </div>

          <button
            onClick={runEstimate}
            disabled={loading}
            className="mt-5 text-sm font-semibold rounded-xl px-5 py-2.5 transition-opacity disabled:opacity-50"
            style={{ color: '#fff', background: 'var(--orange-primary)' }}
          >
            {loading ? 'Estimating…' : 'Estimate from my history'}
          </button>
          {error && (
            <p className="mt-3 text-xs rounded-lg px-3 py-2" style={{ color: 'var(--status-amber)', background: 'rgba(255,152,0,0.1)', border: '1px solid rgba(255,152,0,0.2)' }}>
              {error}
            </p>
          )}
        </section>

        {/* ── Result ─────────────────────────────────────────────────── */}
        {result && result.ok && (
          <section className="grid gap-4">
            {/* Headline */}
            <div className="rounded-2xl p-6" style={{ background: 'var(--bg-surface)', border: '1px solid var(--orange-subtle)' }}>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Estimated client price</p>
                  <p className="text-4xl font-bold tabular-nums mt-1" style={{ color: 'var(--text-primary)' }}>{aud(result.client_price)}</p>
                  <p className="text-sm mt-1 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                    Range {aud(result.range_low)} – {aud(result.range_high)}
                  </p>
                </div>
                <div className="text-right">
                  <span
                    className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-full px-2.5 py-1"
                    style={{ color: confColor(result.confidence), background: 'var(--bg-elevated)', border: `1px solid ${confColor(result.confidence)}` }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: 99, background: confColor(result.confidence) }} />
                    {result.confidence}% confidence
                  </span>
                  <p className="text-xs mt-2 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>{aud(result.cost_per_m2)}/m²</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 mt-5">
                <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--bg-elevated)' }}>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Cost before margin</p>
                  <p className="text-sm font-semibold tabular-nums mt-0.5" style={{ color: 'var(--text-primary)' }}>{aud(result.cost_before_margin)}</p>
                </div>
                <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--bg-elevated)' }}>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Margin</p>
                  <p className="text-sm font-semibold tabular-nums mt-0.5" style={{ color: 'var(--text-primary)' }}>{result.margin_pct}%</p>
                </div>
                <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--bg-elevated)' }}>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Floor area</p>
                  <p className="text-sm font-semibold tabular-nums mt-0.5" style={{ color: 'var(--text-primary)' }}>{result.floor_area_m2.toLocaleString()} m²</p>
                </div>
              </div>
            </div>

            {/* How we got here */}
            <div className="rounded-2xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)' }}>
              <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-tertiary)' }}>How we got here</p>
              <ul className="space-y-2">
                {result.drivers.map((d: string, i: number) => (
                  <li key={i} className="flex items-start gap-2.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    <span style={{ flexShrink: 0, width: 5, height: 5, borderRadius: 99, background: 'var(--orange-primary)', marginTop: 8 }} />
                    {d}
                  </li>
                ))}
              </ul>
            </div>

            {/* Per-trade breakdown */}
            <div className="rounded-2xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)' }}>
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Indicative trade breakdown</p>
                <span className="text-xs" style={{ color: 'var(--text-ghost)' }}>typical residential split</span>
              </div>
              <div className="space-y-2.5">
                {result.per_trade.map((t: EstimateTradeLine) => (
                  <div key={t.trade_category_id} className="flex items-center gap-3">
                    <span className="text-xs w-36 shrink-0 truncate" style={{ color: 'var(--text-secondary)' }}>{t.name}</span>
                    <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-elevated)' }}>
                      <div style={{ width: `${(t.amount / maxTrade) * 100}%`, height: '100%', background: 'var(--orange-primary)', borderRadius: 99 }} />
                    </div>
                    <span className="text-xs font-medium tabular-nums w-20 text-right shrink-0" style={{ color: 'var(--text-primary)' }}>{aud(t.amount)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Why these numbers — confidence + drivers per trade */}
            <ExplainabilityCard
              explainability={toExplainability(result)}
              historicalProjectCount={result.comparable_count}
            />

            {/* Comparables */}
            <div className="rounded-2xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)' }}>
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  Built from {result.comparable_count} of your past job{result.comparable_count !== 1 ? 's' : ''}
                </p>
                {totalInMemory != null && <span className="text-xs" style={{ color: 'var(--text-ghost)' }}>{totalInMemory} in memory</span>}
              </div>
              <div className="space-y-2.5">
                {result.comparables.map((c: EstimateComparable) => (
                  <div key={c.id} className="rounded-xl px-3.5 py-3" style={{ background: 'var(--bg-elevated)' }}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold rounded-full px-2 py-0.5 shrink-0" style={{ color: 'var(--orange-primary)', background: 'var(--orange-subtle)' }}>
                        {c.similarity_score}% match
                      </span>
                      <span className="text-xs font-medium tabular-nums shrink-0" style={{ color: 'var(--text-primary)' }}>
                        {aud(Math.round(c.cost_per_m2))}/m²
                        {c.final_vs_quoted_pct != null && (
                          <span style={{ color: c.final_vs_quoted_pct > 0 ? 'var(--status-red)' : 'var(--status-green)', marginLeft: 6 }}>
                            {c.final_vs_quoted_pct > 0 ? '+' : ''}{c.final_vs_quoted_pct}% final
                          </span>
                        )}
                      </span>
                    </div>
                    <p className="text-xs mt-1.5 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{c.summary}</p>
                  </div>
                ))}
              </div>
            </div>

            <p className="text-xs px-1" style={{ color: 'var(--text-ghost)' }}>
              Estimate is a fast comparison to your history — good enough to quote fast, not a substitute for a full takeoff. Upload the plans to a job for a line-by-line quote.
            </p>
          </section>
        )}

        {result && !result.ok && (
          <div className="rounded-2xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)' }}>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{result.reason}</p>
          </div>
        )}
      </main>
    </div>
  )
}
