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

// ─── Priority order ───────────────────────────────────────────────────────────

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 }

// ─── Component ────────────────────────────────────────────────────────────────

export default function MorningBriefCard({ message, alerts, onAction }: MorningBriefCardProps) {
  const sorted = [...alerts].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
  const summaryText = message.split(/\n+suggested order[:\s]/i)[0].trim()

  return (
    <div className="max-w-full">
      {/* Summary — primary weight, not secondary, to signal authority */}
      <p className="text-[13px] leading-relaxed mb-3" style={{ color: 'var(--text-primary)', lineHeight: '1.5' }}>
        {summaryText}
      </p>

      {sorted.length > 0 && (
        <div className="space-y-2">
          {sorted.map((alert, index) => {
            const isClickable = !!(alert.action && onAction)

            // Badge colors per priority
            const badgeStyle: React.CSSProperties = alert.priority === 'high'
              ? { backgroundColor: 'rgba(244,67,54,0.15)', color: 'var(--status-red)' }
              : alert.priority === 'medium'
              ? { backgroundColor: 'var(--pill-awaiting-bg)', color: 'var(--pill-awaiting-text)' }
              : { backgroundColor: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }

            const badgeLabel = alert.priority === 'high' ? 'HIGH' : alert.priority === 'medium' ? 'MED' : 'LOW'

            const isHigh = alert.priority === 'high'

            return (
              <div
                key={alert.entity_id ? `${alert.entity_id}-${index}` : index}
                role={isClickable ? 'button' : undefined}
                tabIndex={isClickable ? 0 : undefined}
                aria-label={isClickable ? alert.action : undefined}
                className={`rounded-[4px] transition-colors${isClickable ? ' cursor-pointer focus:outline-none' : ''}`}
                style={{
                  padding: isHigh ? '12px 14px' : '8px 12px',
                  backgroundColor: isHigh ? 'rgba(244,67,54,0.06)' : 'var(--bg-surface)',
                  border: isHigh ? '0.5px solid rgba(244,67,54,0.25)' : '0.5px solid var(--bg-border)',
                }}
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
                <div className="flex items-start gap-2.5">
                  {/* Priority badge */}
                  <span
                    className="flex-shrink-0 mt-0.5 text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded-[3px]"
                    style={badgeStyle}
                  >
                    {badgeLabel}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p
                      style={{
                        fontSize: isHigh ? 14 : 13,
                        fontWeight: isHigh ? 500 : 400,
                        lineHeight: 1.45,
                        color: isHigh ? 'var(--text-primary)' : 'var(--text-secondary)',
                      }}
                    >
                      {alert.message}
                    </p>
                    {alert.action && (
                      <p className="mt-1.5 text-[12px] font-medium" style={{ color: 'var(--orange-primary)' }}>
                        {alert.action} →
                      </p>
                    )}
                  </div>
                  {isClickable && (
                    <svg
                      className="flex-shrink-0"
                      width={isHigh ? 14 : 12}
                      height={isHigh ? 14 : 12}
                      style={{ marginTop: 2, color: isHigh ? 'var(--status-red)' : 'var(--text-tertiary)' }}
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
