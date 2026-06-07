'use client'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Alert {
  priority: 'high' | 'medium' | 'low'
  message: string
  action?: string
  quick_action?: string   // one-tap execute (shown as a button, bypasses navigation)
  entity_id?: string
  entity_type?: 'job' | 'invoice' | 'variation' | 'quote'
}

interface MorningBriefCardProps {
  message: string
  alerts: Alert[]
  onAction?: (action: string, entityId?: string, entityType?: string) => void
  onQuickAction?: (quickAction: string, entityId?: string, entityType?: string) => void
}

// ─── Priority order ───────────────────────────────────────────────────────────

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 }

// ─── Blocker detection ────────────────────────────────────────────────────────

type BlockerType = 'CLIENT' | 'TRADE' | 'COUNCIL' | 'SUPPLIER' | null

function detectBlocker(message: string): BlockerType {
  const lower = message.toLowerCase()
  if (lower.includes('waiting on client') || lower.includes('client approval') || lower.includes('no response') || lower.includes('no reply')) return 'CLIENT'
  if (lower.includes('waiting on trade') || lower.includes('subcontractor') || lower.includes('trade invoice')) return 'TRADE'
  if (lower.includes('council') || lower.includes('permit') || lower.includes('approval')) return 'COUNCIL'
  if (lower.includes('waiting on supplier') || lower.includes('supplier')) return 'SUPPLIER'
  return null
}

const BLOCKER_STYLE: Record<NonNullable<BlockerType>, React.CSSProperties> = {
  CLIENT:   { backgroundColor: 'rgba(33,150,243,0.12)', color: 'var(--status-blue)' },
  TRADE:    { backgroundColor: 'var(--pill-awaiting-bg)', color: 'var(--pill-awaiting-text)' },
  COUNCIL:  { backgroundColor: 'rgba(156,39,176,0.12)', color: '#ce93d8' },
  SUPPLIER: { backgroundColor: 'var(--bg-elevated)', color: 'var(--text-tertiary)' },
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MorningBriefCard({ message, alerts, onAction, onQuickAction }: MorningBriefCardProps) {
  const sorted = [...alerts].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
  const summaryText = message.split(/\n+suggested order[:\s]/i)[0].trim()

  return (
    <div className="max-w-full">
      {/* Summary */}
      <p className="text-[13px] leading-relaxed mb-3" style={{ color: 'var(--text-primary)', lineHeight: '1.5' }}>
        {summaryText}
      </p>

      {sorted.length > 0 && (
        <div className="space-y-2">
          {sorted.map((alert, index) => {
            const isClickable = !!(alert.action && onAction)
            const isHigh = alert.priority === 'high'
            const isMed = alert.priority === 'medium'
            const blocker = detectBlocker(alert.message)

            // Badge style
            const badgeStyle: React.CSSProperties = isHigh
              ? { backgroundColor: 'rgba(244,67,54,0.15)', color: 'var(--status-red)' }
              : isMed
              ? { backgroundColor: 'var(--pill-awaiting-bg)', color: 'var(--pill-awaiting-text)' }
              : { backgroundColor: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }

            const badgeLabel = isHigh ? 'URGENT' : isMed ? 'ACTION' : 'FYI'

            // HIGH alerts: larger card with left accent border, prominent quick-action button
            if (isHigh) {
              return (
                <div
                  key={alert.entity_id ? `${alert.entity_id}-${index}` : index}
                  role={isClickable ? 'button' : undefined}
                  tabIndex={isClickable ? 0 : undefined}
                  aria-label={isClickable ? alert.action : undefined}
                  className={`rounded-lg transition-colors${isClickable ? ' cursor-pointer focus:outline-none' : ''}`}
                  style={{
                    padding: '14px 16px',
                    backgroundColor: 'rgba(244,67,54,0.07)',
                    border: '1px solid rgba(244,67,54,0.3)',
                    borderLeft: '3px solid var(--status-red)',
                  }}
                  onClick={() => { if (isClickable) onAction!(alert.action!, alert.entity_id, alert.entity_type) }}
                  onKeyDown={(e) => {
                    if (isClickable && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault()
                      onAction!(alert.action!, alert.entity_id, alert.entity_type)
                    }
                  }}
                >
                  {/* Top row: badge + optional blocker */}
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-[3px]"
                      style={badgeStyle}
                    >
                      {badgeLabel}
                    </span>
                    {blocker && (
                      <span
                        className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded-[3px]"
                        style={BLOCKER_STYLE[blocker]}
                      >
                        Waiting · {blocker}
                      </span>
                    )}
                  </div>
                  {/* Message — large, primary weight */}
                  <p style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: 'var(--text-primary)', marginBottom: 10 }}>
                    {alert.message}
                  </p>
                  {/* Actions row */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {alert.quick_action && onQuickAction && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onQuickAction(alert.quick_action!, alert.entity_id, alert.entity_type)
                        }}
                        className="text-[12px] font-semibold px-3 py-1.5 rounded-[5px] transition-opacity hover:opacity-85"
                        style={{
                          backgroundColor: 'var(--orange-primary)',
                          color: '#fff',
                        }}
                      >
                        {alert.quick_action}
                      </button>
                    )}
                    {alert.action && (
                      <span className="text-[12px] font-medium" style={{ color: 'var(--orange-primary)' }}>
                        {alert.action} →
                      </span>
                    )}
                  </div>
                </div>
              )
            }

            // MEDIUM / LOW alerts: compact row
            return (
              <div
                key={alert.entity_id ? `${alert.entity_id}-${index}` : index}
                role={isClickable ? 'button' : undefined}
                tabIndex={isClickable ? 0 : undefined}
                aria-label={isClickable ? alert.action : undefined}
                className={`rounded-[4px] transition-colors${isClickable ? ' cursor-pointer focus:outline-none' : ''}`}
                style={{
                  padding: '9px 12px',
                  backgroundColor: 'var(--bg-surface)',
                  border: '0.5px solid var(--bg-border)',
                }}
                onClick={() => { if (isClickable) onAction!(alert.action!, alert.entity_id, alert.entity_type) }}
                onKeyDown={(e) => {
                  if (isClickable && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    onAction!(alert.action!, alert.entity_id, alert.entity_type)
                  }
                }}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className="flex-shrink-0 mt-0.5 text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded-[3px]"
                    style={badgeStyle}
                  >
                    {badgeLabel}
                  </span>
                  <div className="flex-1 min-w-0">
                    {blocker && (
                      <span
                        className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded-[3px] flex-shrink-0 mb-1 inline-block"
                        style={BLOCKER_STYLE[blocker]}
                      >
                        Waiting · {blocker}
                      </span>
                    )}
                    <p
                      style={{
                        fontSize: 13,
                        fontWeight: 400,
                        lineHeight: 1.45,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {alert.message}
                    </p>
                    {(alert.action || alert.quick_action) && (
                      <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                        {alert.action && (
                          <span className="text-[12px] font-medium" style={{ color: 'var(--orange-primary)' }}>
                            {alert.action} →
                          </span>
                        )}
                        {alert.quick_action && onQuickAction && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              onQuickAction(alert.quick_action!, alert.entity_id, alert.entity_type)
                            }}
                            className="text-[11px] font-semibold px-2 py-0.5 rounded-[3px] transition-colors"
                            style={{
                              backgroundColor: 'var(--bg-elevated)',
                              border: '0.5px solid rgba(255,107,43,0.4)',
                              color: 'var(--orange-primary)',
                            }}
                          >
                            {alert.quick_action}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {isClickable && (
                    <svg
                      className="flex-shrink-0"
                      width={12}
                      height={12}
                      style={{ marginTop: 3, color: 'var(--text-tertiary)' }}
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
