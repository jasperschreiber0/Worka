'use client'

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
    badge: 'badge-high',
    label: 'HIGH',
    order: 0,
  },
  medium: {
    badge: 'badge-medium',
    label: 'MED',
    order: 1,
  },
  low: {
    badge: 'badge-low',
    label: 'LOW',
    order: 2,
  },
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MorningBriefCard({ message, alerts, onAction }: MorningBriefCardProps) {
  const sorted = [...alerts].sort(
    (a, b) => priorityConfig[a.priority].order - priorityConfig[b.priority].order
  )

  // Strip any "Suggested order:" suffix the AI sometimes appends — the alert
  // cards below already convey that ordered list.
  const summaryText = message.split(/\n+suggested order[:\s]/i)[0].trim()

  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50 p-4 max-w-full">
      <p className="text-sm text-slate-700 leading-relaxed mb-3">{summaryText}</p>

      {sorted.length > 0 && (
        <div className="space-y-2">
          {sorted.map((alert, index) => {
            const config = priorityConfig[alert.priority]
            return (
              <div
                key={alert.entity_id ? `${alert.entity_id}-${index}` : index}
                className="bg-white rounded-md border border-slate-100 px-3 py-2.5"
              >
                <div className="flex items-start gap-2">
                  <span className={`${config.badge} flex-shrink-0 mt-0.5`}>{config.label}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-700 leading-snug">{alert.message}</p>
                    {alert.action && (
                      <button
                        type="button"
                        className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline transition-colors focus:outline-none focus:ring-1 focus:ring-brand-400 rounded"
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
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
