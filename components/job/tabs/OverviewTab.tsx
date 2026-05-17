'use client'

import { useEffect, useState } from 'react'
import type { JobSnapshot } from '@/lib/job-snapshot-demo'
import { proofEventColour, type DemoProofEvent, type ProofEventColour } from '@/lib/activation-demo'

// ─── Props ────────────────────────────────────────────────────────────────────

interface OverviewTabProps {
  overview: JobSnapshot['overview']
  job: JobSnapshot['job']
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

function capitalise(str: string): string {
  if (!str) return str
  return str.charAt(0).toUpperCase() + str.slice(1)
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{label}</p>
      <div>{children}</div>
    </div>
  )
}

// ─── Proof event dot colour ────────────────────────────────────────────────────

function dotColourClass(colour: ProofEventColour): string {
  switch (colour) {
    case 'green':
      return 'bg-green-500'
    case 'amber':
      return 'bg-amber-500'
    default:
      return 'bg-slate-400'
  }
}

// ─── Proof Feed ───────────────────────────────────────────────────────────────

function ProofFeed({ jobId }: { jobId: string }) {
  const [events, setEvents] = useState<DemoProofEvent[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setLoaded(false)
    fetch(`/api/jobs/${jobId}/proof`)
      .then((r) => r.json())
      .then((data: { events: DemoProofEvent[] }) => {
        setEvents(data.events.slice(0, 5))
        setLoaded(true)
      })
      .catch(() => {
        setLoaded(true)
      })
  }, [jobId])

  if (!loaded) {
    return (
      <div className="space-y-3">
        <div className="h-4 w-3/4 bg-slate-200 rounded animate-pulse" />
        <div className="h-4 w-full bg-slate-200 rounded animate-pulse" />
      </div>
    )
  }

  if (events.length === 0) {
    return <p className="text-sm text-slate-400">No events yet — proof feed starts on activation.</p>
  }

  return (
    <div className="space-y-3">
      {events.map((event) => {
        const colour = proofEventColour(event.event_type)
        return (
          <div key={event.id} className="flex items-start gap-2.5">
            <span
              className={`mt-1.5 flex-shrink-0 w-2 h-2 rounded-full ${dotColourClass(colour)}`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm text-slate-800 truncate">{event.description}</p>
                <span className="flex-shrink-0 text-xs text-slate-400">{event.display_time}</span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function OverviewTab({ overview, job }: OverviewTabProps) {
  const statusColour =
    job.status === 'active'
      ? 'bg-green-100 text-green-700'
      : job.status === 'quoted'
        ? 'bg-blue-100 text-blue-700'
        : job.status === 'quoting'
          ? 'bg-amber-100 text-amber-700'
          : 'bg-slate-100 text-slate-600'

  return (
    <div className="p-4 space-y-5">
      {/* Status */}
      <Section label="Status">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusColour}`}
          >
            {capitalise(job.status)}
          </span>
          <span className="text-sm text-slate-600">{overview.started}</span>
        </div>
      </Section>

      {/* Crew */}
      <Section label="Crew on this job">
        {overview.workers_on_job.length > 0 ? (
          <ul className="space-y-1">
            {overview.workers_on_job.map((worker) => (
              <li key={worker} className="text-sm text-slate-700">
                {worker}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-400">No workers assigned yet</p>
        )}
      </Section>

      {/* Last activity */}
      <Section label="Last activity">
        <p className="text-sm text-slate-700">{capitalise(overview.last_activity)}</p>
      </Section>

      {/* Financials */}
      <Section label="Financials">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-sm text-slate-500">Spend to date</span>
          <span className="text-sm text-slate-700 font-medium">
            {overview.spend_to_date !== null ? formatCurrency(overview.spend_to_date) : '—'}
          </span>
          <span className="text-sm text-slate-500">Margin</span>
          <span className="text-sm text-slate-700 font-medium">
            {overview.margin_to_date !== null ? `${overview.margin_to_date}%` : '—'}
          </span>
        </div>
      </Section>

      {/* Notes */}
      <Section label="Notes">
        {overview.notes ? (
          <p className="text-sm text-slate-700 whitespace-pre-line">{overview.notes}</p>
        ) : (
          <p className="text-sm text-slate-400">No notes yet</p>
        )}
      </Section>

      {/* Proof feed */}
      <Section label="Proof feed">
        <ProofFeed jobId={job.id} />
      </Section>
    </div>
  )
}
