'use client'

import { useRouter } from 'next/navigation'

// ─── Demo pipeline data ────────────────────────────────────────────────────────

interface PipelineJob {
  id: string
  address: string
  status: 'sent' | 'in_review' | 'active'
  statusLabel: string
  statusAge: string
  total: number | null
  version: number | null
  confidence: number | null
  actionLabel: string
  actionParam: string
  warning?: boolean
}

const PIPELINE_JOBS: PipelineJob[] = [
  {
    id: '00000000-0000-0000-0000-000000000011',
    address: '8 Burnside Rd, Toorak',
    status: 'sent',
    statusLabel: 'Sent',
    statusAge: '5 days ago',
    total: 127500,
    version: 1,
    confidence: 82,
    actionLabel: 'Follow up',
    actionParam: 'toorak_job',
  },
  {
    id: '00000000-0000-0000-0000-000000000030',
    address: '52 Bendigo St, Brunswick',
    status: 'in_review',
    statusLabel: 'In review',
    statusAge: '',
    total: 127500,
    version: 1,
    confidence: 45,
    actionLabel: '2 items need review',
    actionParam: 'brunswick_job',
    warning: true,
  },
  {
    id: '00000000-0000-0000-0000-000000000010',
    address: '14 Merri St, Fitzroy',
    status: 'active',
    statusLabel: 'Active',
    statusAge: '',
    total: null,
    version: null,
    confidence: null,
    actionLabel: 'View job',
    actionParam: 'fitzroy_job',
  },
]

function formatCurrency(amount: number): string {
  return '$' + amount.toLocaleString('en-AU')
}

function ConfidenceBadge({ score }: { score: number }) {
  const isLow = score < 60
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium ${
        isLow ? 'text-amber-600' : 'text-slate-500'
      }`}
    >
      Conf: {score}%{isLow && ' ⚠'}
    </span>
  )
}

function StatusBadge({ status, label, age }: { status: PipelineJob['status']; label: string; age: string }) {
  const colours: Record<PipelineJob['status'], string> = {
    sent: 'bg-blue-100 text-blue-700',
    in_review: 'bg-amber-100 text-amber-700',
    active: 'bg-green-100 text-green-700',
  }
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colours[status]}`}>
      {label}{age ? ` · ${age}` : ''}
    </span>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function QuotesPipeline() {
  const router = useRouter()

  const handleJobClick = (job: PipelineJob) => {
    router.push(`/chat?job=${job.id}`)
  }

  return (
    <div className="rounded-xl border border-slate-200 shadow-sm overflow-hidden bg-white">
      {PIPELINE_JOBS.map((job, i) => (
        <div
          key={job.id}
          className={`group cursor-pointer px-5 py-4 hover:bg-slate-50 transition-colors duration-150 ${
            i < PIPELINE_JOBS.length - 1 ? 'border-b border-slate-200' : ''
          }`}
          onClick={() => handleJobClick(job)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              handleJobClick(job)
            }
          }}
          aria-label={`Open ${job.address}`}
        >
          <div className="flex items-start justify-between gap-4">
            {/* Left: address + meta */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-slate-800 truncate">
                  {job.address}
                </span>
                <StatusBadge status={job.status} label={job.statusLabel} age={job.statusAge} />
              </div>

              <div className="mt-1 flex items-center gap-3 flex-wrap">
                {job.total !== null && (
                  <span className="text-sm text-slate-600">{formatCurrency(job.total)}</span>
                )}
                {job.version !== null && (
                  <span className="text-xs text-slate-400">v{job.version}</span>
                )}
                {job.confidence !== null && (
                  <ConfidenceBadge score={job.confidence} />
                )}
                {job.status === 'active' && job.total === null && (
                  <span className="text-sm text-slate-400">No quote — went straight to active</span>
                )}
              </div>
            </div>

            {/* Right: action */}
            <div className="flex-shrink-0 flex items-center gap-1.5 text-sm font-medium text-brand-600 group-hover:text-brand-700">
              {job.actionLabel}
              <svg
                className="w-4 h-4 transition-transform duration-150 group-hover:translate-x-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
