'use client'

import { useEffect, useState } from 'react'
import type { JobSnapshot } from '@/lib/job-snapshot-demo'
import { proofEventColour, type DemoProofEvent, type ProofEventColour } from '@/lib/activation-demo'

// ─── Props ────────────────────────────────────────────────────────────────────

import type { JobRisk } from '@/lib/job-snapshot-demo'

interface OverviewTabProps {
  overview: JobSnapshot['overview']
  job: JobSnapshot['job'] & { risks?: JobRisk[] }
  quote?: JobSnapshot['quote']
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
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--text-tertiary)' }}>{label}</p>
      <div>{children}</div>
    </div>
  )
}

// ─── Proof event dot colour ────────────────────────────────────────────────────

function dotStyle(colour: ProofEventColour): React.CSSProperties {
  switch (colour) {
    case 'green': return { backgroundColor: 'var(--status-green)' }
    case 'amber': return { backgroundColor: 'var(--status-amber)' }
    default: return { backgroundColor: 'var(--text-tertiary)' }
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
      .catch(() => { setLoaded(true) })
  }, [jobId])

  if (!loaded) {
    return (
      <div className="space-y-2">
        <div className="h-3 w-3/4 rounded animate-pulse" style={{ backgroundColor: 'var(--bg-elevated)' }} />
        <div className="h-3 w-full rounded animate-pulse" style={{ backgroundColor: 'var(--bg-elevated)' }} />
      </div>
    )
  }

  if (events.length === 0) {
    return <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>No events yet — proof feed starts on activation.</p>
  }

  return (
    <div className="space-y-2.5">
      {events.map((event) => {
        const colour = proofEventColour(event.event_type)
        return (
          <div key={event.id} className="flex items-start gap-2">
            <span className="mt-1.5 flex-shrink-0 w-1.5 h-1.5 rounded-full" style={dotStyle(colour)} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>{event.description}</p>
                <span className="flex-shrink-0 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{event.display_time}</span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Risk card ────────────────────────────────────────────────────────────────

function riskStyle(level: 'high' | 'medium' | 'low'): React.CSSProperties {
  if (level === 'high') return { backgroundColor: 'rgba(244,67,54,0.08)', border: '0.5px solid rgba(244,67,54,0.3)', color: 'var(--status-red)' }
  if (level === 'medium') return { backgroundColor: 'rgba(255,152,0,0.08)', border: '0.5px solid rgba(255,152,0,0.3)', color: 'var(--status-amber)' }
  return { backgroundColor: 'var(--bg-elevated)', border: '0.5px solid var(--bg-border)', color: 'var(--text-tertiary)' }
}

// ─── Status pill ──────────────────────────────────────────────────────────────

function statusPillStyle(status: string): React.CSSProperties {
  if (status === 'active') return { backgroundColor: 'rgba(76,175,80,0.15)', border: '0.5px solid rgba(76,175,80,0.3)', color: 'var(--status-green)' }
  if (status === 'quoted') return { backgroundColor: 'rgba(33,150,243,0.12)', border: '0.5px solid rgba(33,150,243,0.3)', color: 'var(--status-blue)' }
  if (status === 'quoting') return { backgroundColor: 'var(--pill-awaiting-bg)', border: '0.5px solid var(--pill-awaiting-border)', color: 'var(--pill-awaiting-text)' }
  return { backgroundColor: 'var(--bg-elevated)', border: '0.5px solid var(--bg-border)', color: 'var(--text-tertiary)' }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeNextActions(
  job: OverviewTabProps['job'],
  quote: JobSnapshot['quote'],
  risks: JobRisk[]
): string[] {
  const actions: string[] = []

  for (const risk of risks.filter(r => r.level === 'high')) {
    if (risk.message.toLowerCase().includes('passed') || (risk.message.toLowerCase().includes('deadline') && risk.message.toLowerCase().includes('h'))) {
      actions.push('Quote deadline urgent — finalise and send immediately')
    } else if (risk.message.toLowerCase().includes('assumption') && risk.message.toLowerCase().includes('unresolved')) {
      const n = quote?.unresolved_count ?? 0
      actions.push(`Resolve ${n > 0 ? n : 'outstanding'} assumption${n !== 1 ? 's' : ''} — blocking quote from being issued`)
    } else if (risk.message.toLowerCase().includes('no draft exists')) {
      actions.push('Upload plans — no quote started yet')
    }
  }

  for (const risk of risks.filter(r => r.level === 'medium')) {
    if (risk.message.toLowerCase().includes('not yet processed') || risk.message.toLowerCase().includes('intake has not started')) {
      if (!actions.some(a => a.includes('plan'))) actions.push('Plans uploading — check back in a few minutes')
    } else if (risk.message.toLowerCase().includes('no plans uploaded') || risk.message.toLowerCase().includes('budget noted but no plans')) {
      if (!actions.some(a => a.includes('plan'))) actions.push('Upload plans via the Files tab to start quoting')
    }
  }

  for (const risk of risks.filter(r => r.level === 'low')) {
    if (risk.message.toLowerCase().includes('client email')) {
      actions.push('Add client email — required to send the quote')
    }
  }

  if (quote?.status === 'sent' && !actions.some(a => a.includes('deadline') || a.includes('urgent'))) {
    actions.push(`Follow up with client — quote sent ${quote.sent_at ?? 'recently'}, awaiting approval`)
  }

  if (quote?.status === 'approved' && job.status !== 'active') {
    actions.push('Activate job — quote approved, create milestones and invoice schedule')
  }

  if (job.status === 'active' && !actions.length) {
    actions.push('Check variations and invoice schedule are up to date')
  }

  return actions.filter(Boolean).slice(0, 4)
}

function formatDeadline(isoDate: string): string {
  const d = new Date(isoDate)
  const now = new Date()
  const diffDays = Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
  const label = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })
  if (diffDays < 0) return `${label} (overdue)`
  if (diffDays === 0) return `${label} (today)`
  if (diffDays === 1) return `${label} (tomorrow)`
  return `${label} (${diffDays} days)`
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function OverviewTab({ overview, job, quote }: OverviewTabProps) {
  const hasDeadlines = job.quote_deadline || job.client_deadline
  const hasFinancials = overview.spend_to_date !== null || overview.margin_to_date !== null || job.budget_estimate !== null
  const nextActions = computeNextActions(job, quote ?? null, job.risks ?? [])

  return (
    <div style={{ padding: '16px' }} className="space-y-5">
      {/* Status */}
      <Section label="Status">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-[3px]" style={statusPillStyle(job.status)}>
            {capitalise(job.status)}
          </span>
          <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{overview.started}</span>
        </div>
      </Section>

      {/* Next actions */}
      {nextActions.length > 0 && (
        <Section label="Next actions">
          <ol className="space-y-2">
            {nextActions.map((action, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span
                  className="flex-shrink-0 w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center mt-0.5"
                  style={{ backgroundColor: 'var(--orange-primary)', color: '#fff' }}
                >
                  {i + 1}
                </span>
                <p className="text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>{action}</p>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {/* Risks */}
      {job.risks && job.risks.length > 0 && (
        <Section label="Risks">
          <div className="space-y-1.5">
            {job.risks.map((risk, i) => (
              <div key={i} className="flex items-start gap-2 rounded-[4px] px-3 py-2" style={riskStyle(risk.level)}>
                <span className="text-[10px] font-semibold uppercase tracking-wide flex-shrink-0 mt-0.5 min-w-[36px]">
                  {risk.level}
                </span>
                <p className="text-[11px] leading-snug">{risk.message}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Unresolved assumptions */}
      {quote && (quote.unresolved_count ?? 0) > 0 && (
        <Section label="Assumptions">
          <div className="rounded-[4px] px-3 py-2.5"
            style={{ backgroundColor: 'rgba(255,152,0,0.08)', border: '0.5px solid rgba(255,152,0,0.3)' }}>
            <div className="flex items-start gap-2">
              <svg className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                style={{ color: 'var(--status-amber)' }} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <div>
                <p className="text-[12px] font-medium" style={{ color: 'var(--status-amber)' }}>
                  {quote.unresolved_count} assumption{quote.unresolved_count === 1 ? '' : 's'} unresolved
                </p>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  Quote cannot advance until resolved. Type &ldquo;review assumptions&rdquo; in chat.
                </p>
              </div>
            </div>
          </div>
        </Section>
      )}

      {/* Deadlines */}
      {hasDeadlines && (
        <Section label="Deadlines">
          <div className="space-y-1.5">
            {job.quote_deadline && (
              <div className="flex items-baseline justify-between">
                <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Quote due</span>
                <span className={`text-[12px] font-medium`}
                  style={{ color: new Date(job.quote_deadline) < new Date() ? 'var(--status-red)' : 'var(--text-primary)' }}>
                  {formatDeadline(job.quote_deadline)}
                </span>
              </div>
            )}
            {job.client_deadline && (
              <div className="flex items-baseline justify-between">
                <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Client deadline</span>
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  {formatDeadline(job.client_deadline)}
                </span>
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Budget & scope */}
      {(job.budget_estimate || job.scope_notes) && (
        <Section label="Budget & scope">
          <div className="space-y-1.5">
            {job.budget_estimate !== null && (
              <div className="flex items-baseline justify-between">
                <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Budget target</span>
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{formatCurrency(job.budget_estimate)}</span>
              </div>
            )}
            {job.scope_notes && (
              <p className="text-[12px] leading-relaxed whitespace-pre-line" style={{ color: 'var(--text-secondary)' }}>{job.scope_notes}</p>
            )}
          </div>
        </Section>
      )}

      {/* Crew */}
      <Section label="Crew on this job">
        {overview.workers_on_job.length > 0 ? (
          <ul className="space-y-1">
            {overview.workers_on_job.map((worker) => (
              <li key={worker} className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{worker}</li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>No workers assigned yet</p>
        )}
      </Section>

      {/* Last activity */}
      <Section label="Last activity">
        <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{capitalise(overview.last_activity)}</p>
      </Section>

      {/* Financials */}
      {hasFinancials && (
        <Section label="Financials">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {overview.spend_to_date !== null && (
              <>
                <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Spend to date</span>
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{formatCurrency(overview.spend_to_date)}</span>
              </>
            )}
            {overview.margin_to_date !== null && (
              <>
                <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Margin</span>
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{overview.margin_to_date}%</span>
              </>
            )}
            {job.budget_estimate !== null && (
              <>
                <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>Budget target</span>
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{formatCurrency(job.budget_estimate)}</span>
              </>
            )}
          </div>
        </Section>
      )}

      {/* Notes */}
      <Section label="Notes">
        {overview.notes ? (
          <p className="text-[12px] leading-relaxed whitespace-pre-line" style={{ color: 'var(--text-secondary)' }}>{overview.notes}</p>
        ) : (
          <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>No notes</p>
        )}
      </Section>

      {/* Proof feed */}
      <Section label="Proof feed">
        <ProofFeed jobId={job.id} />
      </Section>
    </div>
  )
}
