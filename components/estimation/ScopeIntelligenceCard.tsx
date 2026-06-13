'use client'

import { useState } from 'react'
import type { ScopeHint } from '@/lib/types/estimation.types'

interface ScopeIntelligenceCardProps {
  hints: ScopeHint[]
  onAccept: (hint: ScopeHint) => void
  onDismiss: (hint: ScopeHint) => void
}

const TRADE_NAMES: Record<number, string> = {
  1: 'Earthworks',
  2: 'Concrete',
  3: 'Framing',
  4: 'Roofing',
  5: 'Windows & Doors',
  6: 'Cladding',
  7: 'Insulation',
  8: 'Linings',
  9: 'Joinery',
  10: 'Painting',
  11: 'Plumbing',
  12: 'Electrical',
  13: 'Tiling & Finishes',
}

function confidenceLabel(n: number): string {
  if (n >= 90) return 'Very likely'
  if (n >= 80) return 'Likely'
  if (n >= 70) return 'Possible'
  return 'Worth checking'
}

function confidenceBadgeStyle(n: number): React.CSSProperties {
  if (n >= 90) return { background: 'rgba(244,67,54,0.1)', color: 'var(--status-red)' }
  if (n >= 80) return { background: 'rgba(255,152,0,0.1)', color: 'var(--status-amber)' }
  return { background: 'rgba(33,150,243,0.1)', color: 'var(--status-blue)' }
}

export default function ScopeIntelligenceCard({ hints, onAccept, onDismiss }: ScopeIntelligenceCardProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [accepted, setAccepted] = useState<Set<string>>(new Set())

  const visible = hints.filter(h => !dismissed.has(h.description) && !accepted.has(h.description))

  if (hints.length === 0) return null

  const handleAccept = (hint: ScopeHint) => {
    setAccepted(prev => new Set(Array.from(prev).concat(hint.description)))
    onAccept(hint)
  }

  const handleDismiss = (hint: ScopeHint) => {
    setDismissed(prev => new Set(Array.from(prev).concat(hint.description)))
    onDismiss(hint)
  }

  const allResolved = visible.length === 0

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ border: '0.5px solid var(--bg-border)', background: 'var(--bg-elevated)' }}
    >
      {/* Header */}
      <div
        className="px-4 py-3 border-b"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--bg-border)' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(255,152,0,0.1)' }}
          >
            <svg
              className="w-3.5 h-3.5"
              style={{ color: 'var(--status-amber)' }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Scope intelligence
            </p>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {allResolved
                ? 'All scope items reviewed.'
                : `${visible.length} likely missing item${visible.length !== 1 ? 's' : ''} detected`}
            </p>
          </div>
          {!allResolved && (
            <span
              className="text-xs font-medium px-2 py-0.5 rounded-full"
              style={{
                background: 'var(--pill-awaiting-bg)',
                border: '0.5px solid var(--pill-awaiting-border)',
                color: 'var(--pill-awaiting-text)',
              }}
            >
              Review before sending
            </span>
          )}
        </div>
      </div>

      {/* Hints */}
      {!allResolved && (
        <div className="divide-y" style={{ borderColor: 'var(--bg-border)' }}>
          {visible.map((hint) => (
            <div
              key={hint.description}
              className="px-4 py-3"
              style={{ background: 'var(--bg-surface)' }}
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span
                      className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                      style={confidenceBadgeStyle(hint.confidence)}
                    >
                      {confidenceLabel(hint.confidence)} · {hint.confidence}%
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                      {TRADE_NAMES[hint.trade_category_id]}
                    </span>
                    {hint.typical_cost_range && (
                      <span className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                        {hint.typical_cost_range}
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    {hint.description}
                  </p>
                  <p className="text-xs mt-0.5 leading-snug" style={{ color: 'var(--text-tertiary)' }}>
                    {hint.reason}
                  </p>
                </div>
              </div>
              <div className="flex gap-2 mt-2.5">
                <button
                  onClick={() => handleAccept(hint)}
                  className="flex-1 py-1.5 text-xs font-semibold rounded transition-colors"
                  style={{ background: 'var(--orange-primary)', color: '#fff' }}
                >
                  Add to scope
                </button>
                <button
                  onClick={() => handleDismiss(hint)}
                  className="flex-1 py-1.5 text-xs font-medium rounded transition-colors"
                  style={{
                    border: '0.5px solid var(--bg-border)',
                    color: 'var(--text-secondary)',
                    background: 'transparent',
                  }}
                >
                  Not applicable
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Accepted summary */}
      {accepted.size > 0 && (
        <div
          className="px-4 py-2.5 border-t"
          style={{ background: 'rgba(76,175,80,0.08)', borderColor: 'var(--bg-border)' }}
        >
          <p className="text-xs font-medium" style={{ color: 'var(--status-green)' }}>
            ✓ {accepted.size} item{accepted.size !== 1 ? 's' : ''} added to scope
          </p>
        </div>
      )}
    </div>
  )
}
