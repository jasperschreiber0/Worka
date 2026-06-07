'use client'

import type { StateChange } from '@/app/api/chat/route'

function StatusIcon({ status }: { status: StateChange['status'] }) {
  if (status === 'saved' || status === 'found') {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="flex-shrink-0 mt-0.5">
        <circle cx="7" cy="7" r="6.5" stroke="var(--status-green)" />
        <path d="M4 7l2 2 4-4" stroke="var(--status-green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (status === 'warning') {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="flex-shrink-0 mt-0.5">
        <path d="M7 1.5L13 12.5H1L7 1.5Z" stroke="var(--status-amber)" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M7 5.5V8.5" stroke="var(--status-amber)" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="7" cy="10.5" r="0.6" fill="var(--status-amber)" />
      </svg>
    )
  }
  if (status === 'blocked') {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="flex-shrink-0 mt-0.5">
        <circle cx="7" cy="7" r="6.5" stroke="var(--status-red)" />
        <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="var(--status-red)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="flex-shrink-0 mt-0.5">
      <circle cx="7" cy="7" r="6.5" stroke="var(--text-tertiary)" />
      <path d="M7 6v4" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="7" cy="4" r="0.7" fill="var(--text-tertiary)" />
    </svg>
  )
}

function labelStyle(status: StateChange['status']): React.CSSProperties {
  switch (status) {
    case 'saved':
    case 'found':
      return { color: 'var(--status-green)' }
    case 'warning':
      return { color: 'var(--status-amber)' }
    case 'blocked':
      return { color: 'var(--status-red)' }
    default:
      return { color: 'var(--text-secondary)' }
  }
}

export default function StateUpdateCard({ changes }: { changes: StateChange[] }) {
  if (changes.length === 0) return null

  return (
    <div className="mt-3 rounded-[6px] px-3 py-2.5 space-y-1.5"
      style={{ border: '0.5px solid var(--bg-border)', backgroundColor: 'var(--bg-elevated)' }}>
      {changes.map((change, i) => (
        <div key={i} className="flex items-start gap-2">
          <StatusIcon status={change.status} />
          <span className="text-[12px] leading-tight" style={labelStyle(change.status)}>
            {change.label}
          </span>
        </div>
      ))}
    </div>
  )
}
