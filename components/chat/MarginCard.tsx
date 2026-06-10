'use client'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MarginJob {
  id: string
  job_ref: string
  address: string
  status: string
  quoted_amount: number
  projected_cost: number
  margin_amount: number
  margin_percent: number
  quoted_margin_percent: number
  cost_to_date: number
  variation_impact: number
}

interface MarginCardProps {
  jobs: MarginJob[]
  onOpenJob?: (jobId: string) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatAUD(amount: number): string {
  return `$${Math.abs(amount).toLocaleString('en-AU')}`
}

function marginStatus(pct: number): { label: string; pill: string; bar: string } {
  if (pct < 0) return { label: 'Bleeding', pill: 'bg-[rgba(244,67,54,0.15)] text-[#f44336] border-[rgba(244,67,54,0.3)]', bar: 'bg-[#f44336]' }
  if (pct < 10) return { label: 'At risk', pill: 'bg-[rgba(255,152,0,0.15)] text-[#ff9800] border-[rgba(255,152,0,0.3)]', bar: 'bg-[#ff9800]' }
  if (pct < 15) return { label: 'Watch', pill: 'bg-[rgba(255,152,0,0.15)] text-[#ff9800] border-[rgba(255,152,0,0.3)]', bar: 'bg-[#ff9800]' }
  return { label: 'Healthy', pill: 'bg-[rgba(76,175,80,0.15)] text-[#4caf50] border-[rgba(76,175,80,0.3)]', bar: 'bg-[#4caf50]' }
}

// ─── Single job row ───────────────────────────────────────────────────────────

function MarginRow({ job, onOpenJob }: { job: MarginJob; onOpenJob?: (id: string) => void }) {
  const status = marginStatus(job.margin_percent)
  const isNegative = job.margin_amount < 0
  const barWidth = Math.min(100, Math.max(0, Math.abs(job.margin_percent) / 30 * 100))

  return (
    <div className="bg-[#222222] border border-[#2e2e2e] rounded-[6px] p-4">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[11px] font-mono font-semibold text-[#ff6b2b] bg-[rgba(255,107,43,0.1)] px-1.5 py-0.5 rounded-[3px]">
              {job.job_ref}
            </span>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-[3px] text-[11px] font-medium border ${status.pill}`}
            >
              {status.label}
            </span>
          </div>
          <p className="text-[13px] font-semibold text-[#e0e0e0] truncate">{job.address}</p>
        </div>
        {onOpenJob && (
          <button
            type="button"
            onClick={() => onOpenJob(job.id)}
            className="ml-3 flex-shrink-0 text-[12px] font-medium text-[#ff6b2b] flex items-center gap-1"
            aria-label={`Open ${job.address}`}
          >
            Open
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
          </button>
        )}
      </div>

      {/* Numbers */}
      <div className="grid grid-cols-3 gap-2 mb-3 text-center">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-[#555555] mb-0.5">Quoted</p>
          <p className="text-[13px] font-semibold text-[#e0e0e0]">{formatAUD(job.quoted_amount)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-[#555555] mb-0.5">Tracking</p>
          <p className={`text-[13px] font-semibold ${job.projected_cost > job.quoted_amount ? 'text-[#f44336]' : 'text-[#e0e0e0]'}`}>
            {formatAUD(job.projected_cost)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-[#555555] mb-0.5">Margin</p>
          <p className={`text-[13px] font-semibold ${isNegative ? 'text-[#f44336]' : 'text-[#e0e0e0]'}`}>
            {isNegative ? '–' : ''}{formatAUD(job.margin_amount)}
            <span className="text-[11px] font-normal ml-0.5">({isNegative ? '–' : ''}{Math.abs(job.margin_percent).toFixed(1)}%)</span>
          </p>
        </div>
      </div>

      {/* Margin bar */}
      <div className="mb-1">
        <div className="h-1.5 bg-[#2a2a2a] rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${status.bar}`}
            style={{ width: `${barWidth}%` }}
            role="presentation"
          />
        </div>
      </div>

      {/* Footnote */}
      <div className="flex items-center gap-3 text-[11px] text-[#555555]">
        <span>Quoted {job.quoted_margin_percent.toFixed(0)}% → tracking {isNegative ? '–' : ''}{Math.abs(job.margin_percent).toFixed(1)}%</span>
        {job.variation_impact > 0 && (
          <span className="text-[#f44336]">+{formatAUD(job.variation_impact)} variations</span>
        )}
      </div>
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MarginCard({ jobs, onOpenJob }: MarginCardProps) {
  if (jobs.length === 0) return null

  return (
    <div className="mt-2 w-full max-w-sm space-y-2" role="region" aria-label="Margin summary">
      {/* Section label */}
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-[11px] font-semibold text-[#555555] uppercase tracking-wide">Margin Tracker</span>
        <span className="flex-1 h-px bg-[#2e2e2e]" />
      </div>

      {jobs.map((job) => (
        <MarginRow key={job.id} job={job} onOpenJob={onOpenJob} />
      ))}
    </div>
  )
}
