'use client'

import type { JobSnapshot, ProofEvent } from '@/lib/job-snapshot-demo'

// ─── Props ────────────────────────────────────────────────────────────────────

interface CommsTabProps {
  comms: JobSnapshot['comms']
  onComposeEmail?: () => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function directionDotColor(direction: 'inbound' | 'outbound'): string {
  return direction === 'outbound' ? 'var(--status-blue)' : 'var(--status-green)'
}

function directionLabel(direction: 'inbound' | 'outbound'): string {
  return direction === 'outbound' ? 'OUT' : 'IN'
}

function directionLabelColor(direction: 'inbound' | 'outbound'): string {
  return direction === 'outbound' ? 'var(--status-blue)' : 'var(--status-green)'
}

function capitalise(str: string): string {
  if (!str) return str
  return str.charAt(0).toUpperCase() + str.slice(1)
}

// ─── Proof event sub-component ────────────────────────────────────────────────

function proofEventIcon(type: string): string {
  switch (type) {
    case 'job_activated':       return '🏗'
    case 'variation_submitted': return '📋'
    case 'email_draft_created': return '✏️'
    case 'email_sent':          return '📧'
    case 'variation_approved':  return '✅'
    case 'variation_rejected':  return '❌'
    default:                    return '•'
  }
}

function ProofEventRow({ event }: { event: ProofEvent }) {
  return (
    <li className="flex items-start gap-3">
      <div className="flex-shrink-0 w-5 text-center text-[13px] leading-tight pt-0.5" aria-hidden="true">
        {proofEventIcon(event.type)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] leading-snug" style={{ color: 'var(--text-primary)' }}>
          {event.description}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{event.actor}</span>
          <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>·</span>
          <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            {new Date(event.timestamp).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
          </span>
          {event.entity_ref && (
            <>
              <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>·</span>
              <span className="text-[11px] font-mono" style={{ color: 'var(--orange-primary)' }}>
                {event.entity_ref}
              </span>
            </>
          )}
        </div>
      </div>
    </li>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CommsTab({ comms, onComposeEmail }: CommsTabProps) {
  const messages = comms.messages
  const count = messages.length
  const hasProofEvents = comms.proof_events && comms.proof_events.length > 0

  if (count === 0 && !hasProofEvents) {
    return (
      <div className="p-4 space-y-4">
        <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>No messages yet</p>
        <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          Emails and messages linked to this job will appear here.
        </p>
        {onComposeEmail && (
          <button
            type="button"
            onClick={onComposeEmail}
            className="flex items-center gap-1.5 text-[13px] font-medium transition-colors rounded"
            style={{ color: 'var(--orange-primary)' }}
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
      {count > 0 && (
        <p className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
          {count} message{count !== 1 ? 's' : ''}
        </p>
      )}

      {/* Proof events — audit trail */}
      {hasProofEvents && (
        <div className="mb-4">
          <p
            className="text-[10px] font-semibold uppercase tracking-wide mb-2"
            style={{ color: 'var(--text-secondary)' }}
          >
            Activity trail
          </p>
          <ul className="space-y-2.5">
            {comms.proof_events!.map((event) => (
              <ProofEventRow key={event.id} event={event} />
            ))}
          </ul>
          {count > 0 && (
            <div className="mt-3" style={{ borderTop: '0.5px solid var(--bg-border)' }} />
          )}
        </div>
      )}

      {/* Message list */}
      {count > 0 && (
        <ul className="space-y-3">
          {messages.map((comm) => (
            <li key={comm.id} className="flex items-start gap-3">
              {/* Direction indicator */}
              <div className="flex-shrink-0 flex flex-col items-center gap-1 pt-0.5">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: directionDotColor(comm.direction) }}
                  aria-hidden="true"
                />
              </div>

              {/* Content */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <span
                    className="text-[11px] font-semibold"
                    style={{ color: directionLabelColor(comm.direction) }}
                  >
                    {directionLabel(comm.direction)}
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{comm.timestamp}</span>
                  {comm.channel !== 'email' && (
                    <span className="text-[11px] capitalize" style={{ color: 'var(--text-secondary)' }}>
                      {comm.channel}
                    </span>
                  )}
                </div>
                {comm.subject && (
                  <p className="text-[13px] font-medium leading-snug truncate" style={{ color: 'var(--text-primary)' }}>
                    {comm.subject}
                  </p>
                )}
                <p className="text-[11px] mt-0.5 leading-relaxed line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                  {capitalise(comm.preview)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Compose button */}
      {onComposeEmail && (
        <div className="pt-2" style={{ borderTop: '0.5px solid var(--bg-border)' }}>
          <button
            type="button"
            onClick={onComposeEmail}
            className="flex items-center gap-1.5 text-[13px] font-medium transition-colors rounded"
            style={{ color: 'var(--orange-primary)' }}
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
