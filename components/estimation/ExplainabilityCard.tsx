'use client'

import { useState } from 'react'
import type { TradeExplainability } from '@/lib/types/estimation.types'

interface ExplainabilityCardProps {
  explainability: TradeExplainability[]
  historicalProjectCount: number
}

function formatAUD(n: number): string {
  return `$${n.toLocaleString('en-AU')}`
}

function confidenceBar(pct: number): React.ReactNode {
  const color = pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-amber-500' : 'bg-red-400'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-500 w-8 text-right">{pct}%</span>
    </div>
  )
}

export default function ExplainabilityCard({ explainability, historicalProjectCount }: ExplainabilityCardProps) {
  const [expanded, setExpanded] = useState<number | null>(null)

  if (explainability.length === 0) return null

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
        <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
          <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
          </svg>
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-slate-800">Why these numbers</p>
          <p className="text-xs text-slate-500">
            Informed by {historicalProjectCount} historical project{historicalProjectCount !== 1 ? 's' : ''} · tap a trade to expand
          </p>
        </div>
      </div>

      {/* Trade rows */}
      <div className="divide-y divide-slate-50">
        {explainability.map((item) => {
          const isOpen = expanded === item.trade_category_id
          return (
            <div key={item.trade_category_id}>
              <button
                onClick={() => setExpanded(isOpen ? null : item.trade_category_id)}
                className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-slate-50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <p className="text-sm font-medium text-slate-800">{item.trade_category_name}</p>
                    <p className="text-sm font-semibold text-slate-900 flex-shrink-0">{formatAUD(item.estimated_cost)}</p>
                  </div>
                  {confidenceBar(item.confidence)}
                </div>
                <svg
                  className={`w-4 h-4 flex-shrink-0 text-slate-400 ml-1 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {isOpen && (
                <div className="px-4 pb-4 bg-slate-50 border-t border-slate-100">
                  <div className="pt-3 space-y-2">
                    {item.similar_project_range && (
                      <div className="flex items-start gap-2">
                        <svg className="w-3.5 h-3.5 text-blue-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25" />
                        </svg>
                        <p className="text-xs text-slate-600">{item.similar_project_range}</p>
                      </div>
                    )}
                    {item.historical_accuracy && (
                      <div className="flex items-start gap-2">
                        <svg className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" />
                        </svg>
                        <p className="text-xs text-slate-600">{item.historical_accuracy}</p>
                      </div>
                    )}
                    {item.key_drivers.map((driver, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <svg className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                        </svg>
                        <p className="text-xs text-slate-600">{driver}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
