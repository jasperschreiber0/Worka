'use client'

import { useState } from 'react'
import type { DashboardRecommendation } from '@/app/api/dashboard/route'

interface AIRecommendationsSectionProps {
  recommendations: DashboardRecommendation[]
}

const TYPE_CONFIG = {
  cost: {
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" />
      </svg>
    ),
    iconColor: 'var(--status-amber)',
    iconBg: 'rgba(255, 171, 0, 0.12)',
  },
  margin: {
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    iconColor: 'var(--status-red)',
    iconBg: 'rgba(239, 68, 68, 0.12)',
  },
  opportunity: {
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
      </svg>
    ),
    iconColor: 'var(--status-green)',
    iconBg: 'rgba(34, 197, 94, 0.12)',
  },
  compliance: {
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>
    ),
    iconColor: 'var(--status-blue)',
    iconBg: 'rgba(59, 130, 246, 0.12)',
  },
}

export default function AIRecommendationsSection({ recommendations }: AIRecommendationsSectionProps) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (recommendations.length === 0) return null

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <h2
          className="text-[12px] font-semibold uppercase tracking-wide"
          style={{ color: 'var(--text-secondary)' }}
        >
          AI Recommendations
        </h2>
        <span
          className="text-[11px] font-medium px-1.5 py-0.5 rounded-full"
          style={{ background: 'rgba(255, 107, 43, 0.15)', color: 'var(--orange-primary)' }}
        >
          {recommendations.length}
        </span>
      </div>
      <div className="space-y-2">
        {recommendations.map((rec) => {
          const config = TYPE_CONFIG[rec.type]
          const isOpen = expanded === rec.id
          return (
            <div
              key={rec.id}
              className="rounded-lg border overflow-hidden"
              style={{ background: 'var(--bg-surface)', borderColor: 'var(--bg-border)' }}
            >
              <button
                onClick={() => setExpanded(isOpen ? null : rec.id)}
                className="w-full px-4 py-3 flex items-start gap-3 text-left transition-colors"
                style={{ background: 'transparent' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-elevated)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <span
                  className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5"
                  style={{ color: config.iconColor, background: config.iconBg }}
                >
                  {config.icon}
                </span>
                <div className="flex-1 min-w-0">
                  <p
                    className="text-[13px] font-medium leading-snug"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {rec.message}
                  </p>
                </div>
                <svg
                  className={`w-4 h-4 flex-shrink-0 mt-0.5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                  style={{ color: 'var(--text-tertiary)' }}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {isOpen && (
                <div
                  className="px-4 pb-3 pt-0 border-t"
                  style={{ borderColor: 'var(--bg-border)' }}
                >
                  <p
                    className="text-[13px] leading-relaxed ml-10"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {rec.detail}
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
