'use client'

import type { JobListItem } from '@/app/api/chat/route'

interface JobListCardProps {
  jobs: JobListItem[]
  onOpenJob: (jobId: string, address: string, status: string, clientName?: string) => void
}

function statusStyle(status: string): string {
  if (status === 'active') return 'bg-green-100 text-green-700'
  if (status === 'quoted') return 'bg-blue-100 text-blue-700'
  if (status === 'quoting') return 'bg-amber-100 text-amber-700'
  if (status === 'complete') return 'bg-slate-100 text-slate-600'
  return 'bg-slate-100 text-slate-500'
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export default function JobListCard({ jobs, onOpenJob }: JobListCardProps) {
  return (
    <div className="mt-2 rounded-2xl rounded-tl-sm border border-slate-200 bg-white shadow-sm overflow-hidden">
      {jobs.map((job, i) => (
        <button
          key={job.id}
          type="button"
          onClick={() => onOpenJob(job.id, job.address, job.status, job.client_name)}
          className={`w-full flex items-center justify-between px-4 py-3 text-left transition-colors active:bg-slate-100 hover:bg-slate-50 ${
            i < jobs.length - 1 ? 'border-b border-slate-100' : ''
          }`}
        >
          <div className="min-w-0 flex-1 pr-3">
            <p className="text-sm font-medium text-slate-900 truncate">{job.address}</p>
            <div className="flex items-center gap-2 mt-0.5">
              {job.client_name && (
                <span className="text-xs text-slate-500 truncate">{job.client_name}</span>
              )}
              {job.job_ref && (
                <span className="text-xs text-slate-400">{job.job_ref}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className={`text-xs font-medium px-2 py-0.5 rounded ${statusStyle(job.status)}`}>
              {capitalize(job.status)}
            </span>
            <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </button>
      ))}
    </div>
  )
}
