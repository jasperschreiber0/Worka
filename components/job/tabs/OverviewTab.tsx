'use client'

import type { JobSnapshot } from '@/lib/job-snapshot-demo'

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
    </div>
  )
}
