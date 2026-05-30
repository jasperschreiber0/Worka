'use client'

import { MarkdownContent } from './ChatMessage'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Alert {
  priority: 'high' | 'medium' | 'low'
  message: string
  action?: string
  entity_id?: string
  entity_type?: 'job' | 'invoice' | 'variation' | 'quote'
}

interface MorningBriefCardProps {
  message: string
  alerts: Alert[]
  onAction?: (action: string, entityId?: string, entityType?: string) => void
}

// ─── Priority config ──────────────────────────────────────────────────────────

const priorityConfig = {
  high: {
    dot: 'bg-red-500',
    badge: 'badge-high',
    label: 'HIGH',
    order: 0,
  },
  medium: {
    dot: 'bg-amber-500',
    badge: 'badge-medium',
    label: 'MED',
    order: 1,
  },
  low: {
    dot: 'bg-slate-400',
    badge: 'badge-low',
    label: 'LOW',
    order: 2,
  },
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MorningBriefCard({ message, alerts, onAction }: MorningBriefCardProps) {
  // Sort alerts by priority: high → medium → low
  const sorted = [...alerts].sort(
    (a, b) => priorityConfig[a.priority].order - priorityConfig[b.priority].order
  )

  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50 p-4 max-w-full">
      {/* Summary text */}
      <div className="mb-4 text-sm font-medium text-slate-800 leading-relaxed">
        <MarkdownContent text={message} />
      </div>

      {/* Alerts list */}
      {sorted.length > 0 && (
        <div className="space-y-3">
          {sorted.map((alert, index) => {
            const config = priorityConfig[alert.priority]
            return (
              <div
                key={alert.entity_id ? `${alert.entity_id}-${index}` : index}
                className="flex items-start gap-3"
              >
                {/* Priority dot */}
                <span
                  className={`mt-1 flex-shrink-0 w-2 h-2 rounded-full ${config.dot}`}
                  aria-hidden="true"
                />

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className={config.badge}>{config.label}</span>
                  </div>
                  <p className="text-sm text-slate-700 leading-snug">{alert.message}</p>
                  {alert.action && (
                    <button
                      type="button"
                      className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline transition-colors focus:outline-none focus:ring-1 focus:ring-brand-400 rounded"
                      aria-label={`${alert.action} for this item`}
                      onClick={() => {
                        if (onAction && alert.action) {
                          onAction(alert.action, alert.entity_id, alert.entity_type)
                        }
                      }}
                    >
                      {alert.action}
                      <svg
                        className="w-3 h-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                        aria-hidden="true"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
