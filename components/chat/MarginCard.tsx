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
  if (pct < 0) return { label: 'Bleeding', pill: 'bg-red-100 text-red-700 border-red-200', bar: 'bg-red-500' }
  if (pct < 10) return { label: 'At risk', pill: 'bg-amber-100 text-amber-700 border-amber-200', bar: 'bg-amber-400' }
  if (pct < 15) return { label: 'Watch', pill: 'bg-yellow-100 text-yellow-700 border-yellow-200', bar: 'bg-yellow-400' }
  return { label: 'Healthy', pill: 'bg-green-100 text-green-700 border-green-200', bar: 'bg-green-500' }
}

// ─── Single job row ───────────────────────────────────────────────────────────

function MarginRow({ job, onOpenJob }: { job: MarginJob; onOpenJob?: (id: string) => void }) {
  const status = marginStatus(job.margin_percent)
  const isNegative = job.margin_amount < 0
  const barWidth = Math.min(100, Math.max(0, Math.abs(job.margin_percent) / 30 * 100))

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-xs font-mono font-semibold text-brand-600 bg-brand-50 px-1.5 py-0.5 rounded">
              {job.job_ref}
            </span>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${status.pill}`}
            >
              {status.label}
            </span>
          </div>
          <p className="text-sm font-semibold text-slate-900 truncate">{job.address}</p>
        </div>
        {onOpenJob && (
          <button
            type="button"
            onClick={() => onOpenJob(job.id)}
            className="ml-3 flex-shrink-0 text-xs font-medium text-brand-600 hover:text-brand-700 flex items-center gap-1 transition-colors"
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
          <p className="text-xs text-slate-400 mb-0.5">Quoted</p>
          <p className="text-sm font-bold text-slate-900">{formatAUD(job.quoted_amount)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-400 mb-0.5">Tracking</p>
          <p className={`text-sm font-bold ${job.projected_cost > job.quoted_amount ? 'text-red-600' : 'text-slate-900'}`}>
            {formatAUD(job.projected_cost)}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-400 mb-0.5">Margin</p>
          <p className={`text-sm font-bold ${isNegative ? 'text-red-600' : 'text-slate-900'}`}>
            {isNegative ? '–' : ''}{formatAUD(job.margin_amount)}
            <span className="text-xs font-normal ml-0.5">({isNegative ? '–' : ''}{Math.abs(job.margin_percent).toFixed(1)}%)</span>
          </p>
        </div>
      </div>

      {/* Margin bar */}
      <div className="mb-1">
        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${status.bar}`}
            style={{ width: `${barWidth}%` }}
            role="presentation"
          />
        </div>
      </div>

      {/* Footnote */}
      <div className="flex items-center gap-3 text-xs text-slate-400">
        <span>Quoted {job.quoted_margin_percent.toFixed(0)}% → tracking {isNegative ? '–' : ''}{Math.abs(job.margin_percent).toFixed(1)}%</span>
        {job.variation_impact > 0 && (
          <span className="text-red-500">+{formatAUD(job.variation_impact)} variations</span>
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
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Margin Tracker</span>
        <span className="flex-1 h-px bg-slate-200" />
      </div>

      {jobs.map((job) => (
        <MarginRow key={job.id} job={job} onOpenJob={onOpenJob} />
      ))}
    </div>
  )
}
