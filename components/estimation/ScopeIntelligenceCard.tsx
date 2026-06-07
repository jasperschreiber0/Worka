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

function confidenceColor(n: number): string {
  if (n >= 90) return 'text-red-600 bg-red-50'
  if (n >= 80) return 'text-amber-600 bg-amber-50'
  return 'text-blue-600 bg-blue-50'
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
    <div className="rounded-lg border border-amber-200 bg-amber-50 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-white border-b border-amber-100">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
            <svg className="w-3.5 h-3.5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-slate-800">Scope intelligence</p>
            <p className="text-xs text-slate-500">
              {allResolved
                ? 'All scope items reviewed.'
                : `${visible.length} likely missing item${visible.length !== 1 ? 's' : ''} detected`}
            </p>
          </div>
          {!allResolved && (
            <span className="text-xs text-amber-700 bg-amber-100 font-medium px-2 py-0.5 rounded-full">
              Review before sending
            </span>
          )}
        </div>
      </div>

      {/* Hints */}
      {!allResolved && (
        <div className="divide-y divide-amber-100">
          {visible.map((hint) => (
            <div key={hint.description} className="px-4 py-3 bg-white">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${confidenceColor(hint.confidence)}`}>
                      {confidenceLabel(hint.confidence)} · {hint.confidence}%
                    </span>
                    <span className="text-[10px] text-slate-400">{TRADE_NAMES[hint.trade_category_id]}</span>
                    {hint.typical_cost_range && (
                      <span className="text-[10px] text-slate-500 font-medium">{hint.typical_cost_range}</span>
                    )}
                  </div>
                  <p className="text-sm font-medium text-slate-800">{hint.description}</p>
                  <p className="text-xs text-slate-500 mt-0.5 leading-snug">{hint.reason}</p>
                </div>
              </div>
              <div className="flex gap-2 mt-2.5">
                <button
                  onClick={() => handleAccept(hint)}
                  className="flex-1 py-1.5 text-xs font-semibold rounded bg-brand-500 text-white hover:bg-brand-600 transition-colors"
                >
                  Add to scope
                </button>
                <button
                  onClick={() => handleDismiss(hint)}
                  className="flex-1 py-1.5 text-xs font-medium rounded border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
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
        <div className="px-4 py-2.5 bg-green-50 border-t border-amber-100">
          <p className="text-xs text-green-700 font-medium">
            ✓ {accepted.size} item{accepted.size !== 1 ? 's' : ''} added to scope
          </p>
        </div>
      )}
    </div>
  )
}
