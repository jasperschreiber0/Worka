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
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">Needs Attention</h2>
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-center">
          <p className="text-sm text-slate-400">Nothing needs attention right now.</p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">Needs Attention</h2>
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
              className="bg-white rounded-lg border border-slate-100 px-4 py-3 cursor-pointer hover:border-brand-200 hover:bg-brand-50 transition-colors focus:outline-none focus:ring-1 focus:ring-brand-400"
            >
              <div className="flex items-start gap-2.5">
                <span className={`${config.badge} flex-shrink-0 mt-0.5`}>{config.label}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-700 leading-snug">{alert.message}</p>
                  {alert.action && (
                    <p className="mt-1 text-xs font-medium text-brand-600">{alert.action} →</p>
                  )}
                </div>
                <svg className="w-3.5 h-3.5 flex-shrink-0 text-slate-300 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden>
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
