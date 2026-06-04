'use client'

import Link from 'next/link'

// ─── Stage definitions ────────────────────────────────────────────────────────

const JOB_STAGES = [
  { id: 'quoting', label: 'Lead', desc: 'Building the quote' },
  { id: 'quoted',  label: 'Quote', desc: 'Sent, awaiting approval' },
  { id: 'active',  label: 'Active', desc: 'Work underway' },
  { id: 'complete', label: 'Complete', desc: 'Work finished' },
  { id: 'archived', label: 'Invoiced', desc: 'All paid & closed' },
]

function stageIndex(status: string): number {
  const idx = JOB_STAGES.findIndex((s) => s.id === status)
  return idx >= 0 ? idx : 0
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface StatePanelProps {
  jobAddress: string
  jobStatus: string
  jobRef?: string | null
  quoteDeadline?: string | null
  clientDeadline?: string | null
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function StatePanel({
  jobAddress,
  jobStatus,
  jobRef,
  quoteDeadline,
  clientDeadline,
}: StatePanelProps) {
  const currentIdx = stageIndex(jobStatus)

  return (
    <div className="flex flex-col h-full bg-white border-r border-slate-200 overflow-hidden">
      {/* Back + job identity */}
      <div className="px-4 pt-4 pb-3 border-b border-slate-100 flex-shrink-0">
        <Link
          href="/jobs"
          className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
          </svg>
          All jobs
        </Link>
        <p className="mt-2 text-sm font-semibold text-slate-900 leading-snug line-clamp-3">
          {jobAddress || 'Loading…'}
        </p>
        {jobRef && (
          <p className="text-xs text-slate-400 mt-0.5">{jobRef}</p>
        )}
      </div>

      {/* State machine */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-4">
          Stage
        </p>

        <ol className="space-y-0">
          {JOB_STAGES.map((stage, idx) => {
            const isCurrent = idx === currentIdx
            const isPast = idx < currentIdx
            const isLast = idx === JOB_STAGES.length - 1

            return (
              <li key={stage.id} className="flex items-start gap-3">
                {/* Connector column */}
                <div className="flex flex-col items-center flex-shrink-0 pt-0.5">
                  <div
                    className={`w-2.5 h-2.5 rounded-full border-2 flex-shrink-0 ${
                      isCurrent
                        ? 'border-brand-500 bg-brand-500'
                        : isPast
                          ? 'border-brand-300 bg-brand-100'
                          : 'border-slate-300 bg-white'
                    }`}
                  />
                  {!isLast && (
                    <div
                      className={`w-0.5 h-6 mt-0.5 ${
                        idx < currentIdx ? 'bg-brand-200' : 'bg-slate-200'
                      }`}
                    />
                  )}
                </div>

                {/* Label */}
                <div className={`pb-4 min-w-0 ${isLast ? 'pb-0' : ''}`}>
                  <p
                    className={`text-sm leading-none ${
                      isCurrent
                        ? 'font-semibold text-brand-700'
                        : isPast
                          ? 'font-medium text-slate-500'
                          : 'font-normal text-slate-400'
                    }`}
                  >
                    {stage.label}
                    {isCurrent && (
                      <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-brand-100 text-brand-700 leading-none">
                        Now
                      </span>
                    )}
                  </p>
                  {isCurrent && (
                    <p className="text-xs text-slate-400 mt-0.5">{stage.desc}</p>
                  )}
                </div>
              </li>
            )
          })}
        </ol>

        {/* Key dates */}
        {(quoteDeadline || clientDeadline) && (
          <div className="mt-5 pt-4 border-t border-slate-100">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
              Key dates
            </p>
            {quoteDeadline && (
              <div className="flex items-start gap-2 text-xs text-slate-600 mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0 mt-1" />
                <div>
                  <p className="font-medium text-slate-700">Quote deadline</p>
                  <p className="text-slate-500">{quoteDeadline}</p>
                </div>
              </div>
            )}
            {clientDeadline && (
              <div className="flex items-start gap-2 text-xs text-slate-600">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0 mt-1" />
                <div>
                  <p className="font-medium text-slate-700">Client deadline</p>
                  <p className="text-slate-500">{clientDeadline}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
