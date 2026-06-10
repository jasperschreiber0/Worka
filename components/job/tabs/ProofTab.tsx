'use client'

import { useState, useEffect } from 'react'
import type { DemoProofEvent } from '@/lib/activation-demo'

interface ProofChainStatus {
  verified: boolean
  chained_count: number
  total_count: number
}

interface ProofTabProps {
  jobId: string
}

const EVENT_ICONS: Record<string, React.ReactNode> = {
  upload: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
    </svg>
  ),
  quote_sent: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
    </svg>
  ),
  invoice_sent: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 01-.75.75h-.75" />
    </svg>
  ),
  variation_approved: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  variation_pending: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
    </svg>
  ),
  job_activated: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  ),
  email_sent: (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
    </svg>
  ),
}

function eventIconStyle(eventType: string): { backgroundColor: string; color: string } {
  switch (eventType) {
    case 'quote_sent':
      return { backgroundColor: 'rgba(59,130,246,0.15)', color: 'var(--status-blue)' }
    case 'invoice_sent':
    case 'variation_approved':
      return { backgroundColor: 'rgba(34,197,94,0.15)', color: 'var(--status-green)' }
    case 'variation_pending':
    case 'variation_notice_sent':
      return { backgroundColor: 'rgba(245,158,11,0.15)', color: 'var(--status-amber)' }
    case 'email_sent':
      return { backgroundColor: 'rgba(59,130,246,0.15)', color: 'var(--status-blue)' }
    case 'job_activated':
      return { backgroundColor: 'rgba(255,107,43,0.15)', color: 'var(--orange-primary)' }
    default:
      return { backgroundColor: 'var(--bg-elevated)', color: 'var(--text-secondary)' }
  }
}

function formatTime(ts: string): string {
  const d = new Date(ts)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: diffDays > 365 ? 'numeric' : undefined })
}

function groupByDate(events: DemoProofEvent[]) {
  const groups = new Map<string, DemoProofEvent[]>()
  for (const event of events) {
    const d = new Date(event.created_at)
    const now = new Date()
    const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))
    let label: string
    if (diffDays === 0) label = 'Today'
    else if (diffDays === 1) label = 'Yesterday'
    else label = d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })

    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(event)
  }
  return groups
}

export default function ProofTab({ jobId }: ProofTabProps) {
  const [events, setEvents] = useState<DemoProofEvent[]>([])
  const [chain, setChain] = useState<ProofChainStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/jobs/${jobId}/proof`)
      .then(r => r.json())
      .then(data => {
        setEvents(data.events ?? [])
        setChain(data.chain ?? null)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [jobId])

  if (loading) {
    return (
      <div className="p-4 space-y-4">
        {[1, 2, 3].map(i => (
          <div key={i} className="flex gap-3">
            <div
              className="w-7 h-7 rounded-full animate-pulse flex-shrink-0"
              style={{ backgroundColor: 'var(--bg-elevated)' }}
            />
            <div className="flex-1 space-y-2 pt-1">
              <div className="h-3.5 rounded animate-pulse w-3/4" style={{ backgroundColor: 'var(--bg-elevated)' }} />
              <div className="h-3 rounded animate-pulse w-1/3" style={{ backgroundColor: 'var(--bg-elevated)' }} />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="p-6 text-center">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center mx-auto mb-3"
          style={{ backgroundColor: 'var(--bg-elevated)' }}
        >
          <svg
            className="w-5 h-5"
            style={{ color: 'var(--text-tertiary)' }}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
          </svg>
        </div>
        <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>No proof events recorded yet.</p>
        <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>Actions like quotes, variations, and invoices appear here automatically.</p>
      </div>
    )
  }

  const groups = groupByDate(events)
  const chainIntact = chain && chain.chained_count > 0 && chain.verified
  const chainBroken = chain && chain.chained_count > 0 && !chain.verified

  return (
    <div className="p-4">
      {/* Integrity status */}
      <div className="mb-4">
        <p
          className="text-[11px]"
          style={{ color: chainBroken ? 'var(--status-red)' : 'var(--text-tertiary)' }}
        >
          {chainBroken
            ? 'Integrity check failed — contact support'
            : chainIntact
              ? `Tamper-evident · ${chain.chained_count} of ${chain.total_count} events hash-verified`
              : 'Legal-grade chronological record of all job activity.'}
        </p>
      </div>

      {Array.from(groups.entries()).map(([dateLabel, dateEvents]) => (
        <div key={dateLabel} className="mb-5">
          <div className="flex items-center gap-2 mb-3">
            <div className="h-px flex-1" style={{ backgroundColor: 'var(--bg-border)' }} />
            <span
              className="text-[10px] font-medium uppercase tracking-wide"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {dateLabel}
            </span>
            <div className="h-px flex-1" style={{ backgroundColor: 'var(--bg-border)' }} />
          </div>

          <div className="space-y-0">
            {dateEvents.map((event, i) => {
              const iconStyle = eventIconStyle(event.event_type)
              const icon = EVENT_ICONS[event.event_type] ?? EVENT_ICONS['upload']
              return (
                <div
                  key={event.id}
                  className="flex items-start gap-3 py-2.5 last:border-0"
                  style={{ borderBottom: i < dateEvents.length - 1 ? '0.5px solid var(--bg-border)' : undefined }}
                >
                  <div className="flex flex-col items-center flex-shrink-0 mt-0.5">
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center"
                      style={iconStyle}
                    >
                      {icon}
                    </div>
                    {i < dateEvents.length - 1 && (
                      <div className="w-px flex-1 mt-1 min-h-[12px]" style={{ backgroundColor: 'var(--bg-border)' }} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0 pb-1">
                    <p className="text-[13px] leading-snug" style={{ color: 'var(--text-primary)' }}>
                      {event.description}
                    </p>
                  </div>
                  <span
                    className="text-[11px] flex-shrink-0 mt-0.5 whitespace-nowrap"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {event.display_time ?? formatTime(event.created_at)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      <div className="mt-4 pt-3" style={{ borderTop: '0.5px solid var(--bg-border)' }}>
        <p className="text-[11px] mb-2" style={{ color: 'var(--text-tertiary)' }}>
          {events.length} event{events.length !== 1 ? 's' : ''} recorded
        </p>
        <a
          href={`/api/jobs/${jobId}/proof/export`}
          download
          className="text-[12px] font-medium"
          style={{ color: 'var(--orange-primary)' }}
        >
          Download Proof Pack →
        </a>
        <p className="text-[10px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
          Timestamped evidence document for payment disputes.
        </p>
      </div>
    </div>
  )
}
