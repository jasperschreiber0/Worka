'use client'

import { useState, useEffect } from 'react'
import { proofEventColour } from '@/lib/activation-demo'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProofTabEvent {
  id: string
  job_id: string
  event_type: string
  description: string
  metadata: Record<string, unknown> | null
  created_at: string
  display_time: string
}

interface ProofChainStatus {
  verified: boolean
  chained_count: number
  total_count: number
}

interface ProofResponse {
  events: ProofTabEvent[]
  total: number
  chain: ProofChainStatus
}

interface ProofTabProps {
  jobId: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dotClass(eventType: string): string {
  switch (proofEventColour(eventType)) {
    case 'green':
      return 'bg-green-500'
    case 'amber':
      return 'bg-amber-500'
    default:
      return 'bg-slate-400'
  }
}

function eventTypeLabel(eventType: string): string {
  const label = eventType.replace(/_/g, ' ')
  return label.charAt(0).toUpperCase() + label.slice(1)
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ProofTab({ jobId }: ProofTabProps) {
  const [data, setData] = useState<ProofResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/jobs/${jobId}/proof`)
      .then((r) => r.json())
      .then((res: ProofResponse) => {
        setData(res)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [jobId])

  if (loading) {
    return (
      <div className="p-4 space-y-3">
        <div className="h-4 w-40 bg-slate-200 rounded animate-pulse" />
        <div className="h-4 w-full bg-slate-200 rounded animate-pulse" />
        <div className="h-4 w-3/4 bg-slate-200 rounded animate-pulse" />
      </div>
    )
  }

  const events = data?.events ?? []
  const chain = data?.chain

  if (events.length === 0) {
    return (
      <div className="p-4 space-y-2">
        <p className="text-sm text-slate-500">No proof events yet</p>
        <p className="text-xs text-slate-400">
          Every quote sent, variation decision, and client email on this job is recorded here
          automatically — your evidence trail if a payment is ever disputed.
        </p>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      {/* Integrity banner */}
      <div
        className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 ${
          chain && chain.chained_count > 0 && !chain.verified
            ? 'bg-red-50 border border-red-200'
            : 'bg-green-50 border border-green-200'
        }`}
      >
        <svg
          className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
            chain && chain.chained_count > 0 && !chain.verified ? 'text-red-600' : 'text-green-600'
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
          />
        </svg>
        <div className="min-w-0">
          <p
            className={`text-xs font-semibold ${
              chain && chain.chained_count > 0 && !chain.verified ? 'text-red-700' : 'text-green-700'
            }`}
          >
            {chain && chain.chained_count > 0 && !chain.verified
              ? 'Integrity check failed — contact support'
              : 'Tamper-evident record'}
          </p>
          <p className="text-xs text-slate-500 mt-0.5">
            {events.length} event{events.length !== 1 ? 's' : ''} recorded automatically
            {chain && chain.chained_count > 0 && chain.verified
              ? ` · ${chain.chained_count} hash-chained and verified`
              : ''}
          </p>
        </div>
      </div>

      {/* Event timeline */}
      <ul className="space-y-3">
        {events.map((event) => (
          <li key={event.id} className="flex items-start gap-3">
            <span
              className={`flex-shrink-0 w-2 h-2 rounded-full mt-1.5 ${dotClass(event.event_type)}`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-slate-800 leading-snug">{event.description}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-slate-400">{event.display_time}</span>
                <span className="text-xs text-slate-300">·</span>
                <span className="text-xs text-slate-400">{eventTypeLabel(event.event_type)}</span>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* Download proof pack */}
      <div className="pt-2 border-t border-slate-200">
        <a
          href={`/api/jobs/${jobId}/proof/export`}
          download
          className="flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline transition-colors focus-visible:ring-2 focus-visible:ring-brand-400 active:text-brand-800 rounded"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          Download Proof Pack
        </a>
        <p className="text-xs text-slate-400 mt-1.5">
          A timestamped evidence document you can attach to a payment claim or dispute.
        </p>
      </div>
    </div>
  )
}
