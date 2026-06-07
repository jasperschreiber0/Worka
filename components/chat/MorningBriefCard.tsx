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

  const badgeClass = {
    high: 'bg-[rgba(244,67,54,0.15)] text-[#f44336] text-[10px] font-medium uppercase px-1.5 py-0.5 rounded-[3px]',
    medium: 'bg-[rgba(255,152,0,0.15)] text-[#ff9800] text-[10px] font-medium uppercase px-1.5 py-0.5 rounded-[3px]',
    low: 'bg-[#2a2a2a] text-[#555555] text-[10px] font-medium uppercase px-1.5 py-0.5 rounded-[3px]',
  }

  return (
    <div className="max-w-full">
      <p className="text-[#999999] text-[13px] leading-relaxed mb-3">{summaryText}</p>

      {sorted.length > 0 && (
        <div className="space-y-2">
          {sorted.map((alert, index) => {
            const config = priorityConfig[alert.priority]
            const isClickable = !!(alert.action && onAction)
            return (
              <div
                key={alert.entity_id ? `${alert.entity_id}-${index}` : index}
                role={isClickable ? 'button' : undefined}
                tabIndex={isClickable ? 0 : undefined}
                aria-label={isClickable ? alert.action : undefined}
                className={`bg-[#222222] border border-[#2e2e2e] rounded-[4px] px-3 py-2.5 transition-colors ${
                  isClickable
                    ? 'cursor-pointer hover:border-[#ff6b2b]/30 focus:outline-none'
                    : ''
                }`}
                onClick={() => {
                  if (isClickable) onAction!(alert.action!, alert.entity_id, alert.entity_type)
                }}
                onKeyDown={(e) => {
                  if (isClickable && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    onAction!(alert.action!, alert.entity_id, alert.entity_type)
                  }
                }}
              >
                <div className="flex items-start gap-2">
                  <span className={`${badgeClass[alert.priority]} flex-shrink-0 mt-0.5`}>{config.label}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[#e0e0e0] text-[13px] leading-snug">{alert.message}</p>
                    {alert.action && (
                      <p className="mt-1 text-[#ff6b2b] text-[12px]">
                        {alert.action} →
                      </p>
                    )}
                  </div>
                  {isClickable && (
                    <svg
                      className="w-3.5 h-3.5 flex-shrink-0 text-[#555555] mt-0.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
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
