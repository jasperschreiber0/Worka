'use client'

import { useRouter } from 'next/navigation'
import type { DashboardAlert } from '@/app/api/dashboard/route'

interface NeedsAttentionSectionProps {
  alerts: DashboardAlert[]
  onJobOpen?: (jobId: string) => void
}

const PRIORITY_CONFIG = {
  high: { badge: 'badge-high', label: 'HIGH', order: 0 },
  medium: { badge: 'badge-medium', label: 'MED', order: 1 },
  low: { badge: 'badge-low', label: 'LOW', order: 2 },
}

export default function NeedsAttentionSection({ alerts, onJobOpen }: NeedsAttentionSectionProps) {
  const router = useRouter()

  const sorted = [...alerts].sort((a, b) => PRIORITY_CONFIG[a.priority].order - PRIORITY_CONFIG[b.priority].order)

  const handleClick = (alert: DashboardAlert) => {
    if (alert.action === 'Open job' && alert.entity_id && onJobOpen) {
      onJobOpen(alert.entity_id)
      return
    }
    if (alert.action === 'Review variations' && alert.entity_id) {
      router.push(`/chat?q=show variations for ${alert.entity_id}`)
      return
    }
    if (alert.action === 'Chase payment' && alert.entity_id) {
      router.push(`/chat?q=chase payment for invoice ${alert.entity_id}`)
      return
    }
    if (alert.action === 'Follow up' && alert.entity_id) {
      router.push(`/chat?q=follow up on quote ${alert.entity_id}`)
      return
    }
    router.push('/chat')
  }

  if (sorted.length === 0) {
    return (
      <div>
        <h2
          className="text-[12px] font-semibold uppercase tracking-wide mb-3"
          style={{ color: 'var(--text-secondary)' }}
        >
          Needs Attention
        </h2>
        <div
          className="rounded-lg border px-4 py-6 text-center"
          style={{ background: 'var(--bg-surface)', borderColor: 'var(--bg-border)' }}
        >
          <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
            Nothing needs attention right now.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h2
        className="text-[12px] font-semibold uppercase tracking-wide mb-3"
        style={{ color: 'var(--text-secondary)' }}
      >
        Needs Attention
      </h2>
      <div className="space-y-2">
        {sorted.map((alert, i) => {
          const config = PRIORITY_CONFIG[alert.priority]
          return (
            <div
              key={alert.id ?? i}
              role="button"
              tabIndex={0}
              onClick={() => handleClick(alert)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(alert) } }}
              className="rounded-lg border px-4 py-3 cursor-pointer transition-colors focus:outline-none focus:ring-1"
              style={{
                background: 'var(--bg-surface)',
                borderColor: 'var(--bg-border)',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-elevated)'
                ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--orange-primary)'
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-surface)'
                ;(e.currentTarget as HTMLDivElement).style.borderColor = 'var(--bg-border)'
              }}
            >
              <div className="flex items-start gap-2.5">
                <span className={`${config.badge} flex-shrink-0 mt-0.5`}>{config.label}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] leading-snug" style={{ color: 'var(--text-primary)' }}>
                    {alert.message}
                  </p>
                  {alert.action && (
                    <p className="mt-1 text-[11px] font-medium" style={{ color: 'var(--orange-primary)' }}>
                      {alert.action} →
                    </p>
                  )}
                </div>
                <svg
                  className="w-3.5 h-3.5 flex-shrink-0 mt-0.5"
                  style={{ color: 'var(--text-tertiary)' }}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
