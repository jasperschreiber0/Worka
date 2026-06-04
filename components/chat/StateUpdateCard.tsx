'use client'

import type { StateChange } from '@/app/api/chat/route'

// ─── Icon helpers ─────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: StateChange['status'] }) {
  if (status === 'saved' || status === 'found') {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="flex-shrink-0 mt-0.5">
        <circle cx="7" cy="7" r="6.5" stroke="#16a34a" />
        <path d="M4 7l2 2 4-4" stroke="#16a34a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (status === 'warning') {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="flex-shrink-0 mt-0.5">
        <path d="M7 1.5L13 12.5H1L7 1.5Z" stroke="#d97706" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M7 5.5V8.5" stroke="#d97706" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="7" cy="10.5" r="0.6" fill="#d97706" />
      </svg>
    )
  }
  if (status === 'blocked') {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="flex-shrink-0 mt-0.5">
        <circle cx="7" cy="7" r="6.5" stroke="#dc2626" />
        <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  }
  // info
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="flex-shrink-0 mt-0.5">
      <circle cx="7" cy="7" r="6.5" stroke="#6b7280" />
      <path d="M7 6v4" stroke="#6b7280" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="7" cy="4" r="0.7" fill="#6b7280" />
    </svg>
  )
}

function labelColour(status: StateChange['status']): string {
  switch (status) {
    case 'saved':
    case 'found':
      return 'text-green-700'
    case 'warning':
      return 'text-amber-700'
    case 'blocked':
      return 'text-red-700'
    default:
      return 'text-slate-600'
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function StateUpdateCard({ changes }: { changes: StateChange[] }) {
  if (changes.length === 0) return null

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 space-y-2">
      {changes.map((change, i) => (
        <div key={i} className="flex items-start gap-2">
          <StatusIcon status={change.status} />
          <span className={`text-sm leading-tight ${labelColour(change.status)}`}>
            {change.label}
          </span>
        </div>
      ))}
    </div>
  )
}
