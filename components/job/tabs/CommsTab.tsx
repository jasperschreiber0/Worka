'use client'

import type { JobSnapshot } from '@/lib/job-snapshot-demo'

// ─── Props ────────────────────────────────────────────────────────────────────

interface CommsTabProps {
  comms: JobSnapshot['comms']
  onComposeEmail?: () => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function directionDotClass(direction: 'inbound' | 'outbound'): string {
  return direction === 'outbound' ? 'bg-blue-500' : 'bg-green-500'
}

function directionLabel(direction: 'inbound' | 'outbound'): string {
  return direction === 'outbound' ? 'OUT' : 'IN'
}

function directionLabelClass(direction: 'inbound' | 'outbound'): string {
  return direction === 'outbound' ? 'text-blue-600' : 'text-green-600'
}

function capitalise(str: string): string {
  if (!str) return str
  return str.charAt(0).toUpperCase() + str.slice(1)
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CommsTab({ comms, onComposeEmail }: CommsTabProps) {
  const messages = comms.messages
  const count = messages.length

  if (count === 0) {
    return (
      <div className="p-4 space-y-4">
        <p className="text-sm text-slate-500">No messages yet</p>
        <p className="text-xs text-slate-400">
          Emails and messages linked to this job will appear here.
        </p>
        {onComposeEmail && (
          <button
            type="button"
            onClick={onComposeEmail}
            className="flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline transition-colors focus:outline-none focus:ring-1 focus:ring-brand-400 rounded"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Compose email
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="p-4 space-y-3">
      {/* Count header */}
      <p className="text-sm font-medium text-slate-700">
        {count} message{count !== 1 ? 's' : ''}
      </p>

      {/* Message list */}
      <ul className="space-y-3">
        {messages.map((comm) => (
          <li key={comm.id} className="flex items-start gap-3">
            {/* Direction indicator */}
            <div className="flex-shrink-0 flex flex-col items-center gap-1 pt-0.5">
              <span
                className={`w-2 h-2 rounded-full ${directionDotClass(comm.direction)}`}
                aria-hidden="true"
              />
            </div>

            {/* Content */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-0.5">
                <span
                  className={`text-xs font-semibold ${directionLabelClass(comm.direction)}`}
                >
                  {directionLabel(comm.direction)}
                </span>
                <span className="text-xs text-slate-400">{comm.timestamp}</span>
                {comm.channel !== 'email' && (
                  <span className="text-xs text-slate-400 capitalize">{comm.channel}</span>
                )}
              </div>
              {comm.subject && (
                <p className="text-sm text-slate-800 font-medium leading-snug truncate">
                  {comm.subject}
                </p>
              )}
              <p className="text-xs text-slate-500 mt-0.5 leading-relaxed line-clamp-2">
                {capitalise(comm.preview)}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {/* Compose button */}
      {onComposeEmail && (
        <div className="pt-2 border-t border-slate-200">
          <button
            type="button"
            onClick={onComposeEmail}
            className="flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline transition-colors focus:outline-none focus:ring-1 focus:ring-brand-400 rounded"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Compose email
          </button>
        </div>
      )}
    </div>
  )
}
