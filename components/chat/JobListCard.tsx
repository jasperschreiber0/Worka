'use client'
import React from 'react'
import type { JobAttention, JobListItem } from '@/app/api/chat/route'

interface JobListCardProps {
  jobs: JobListItem[]
  onOpenJob: (jobId: string, address: string, status: string, clientName?: string) => void
}

function statusStyle(status: string): React.CSSProperties {
  if (status === 'active') return { backgroundColor: 'rgba(76,175,80,0.12)', color: 'var(--status-green)' }
  if (status === 'quoted') return { backgroundColor: 'rgba(33,150,243,0.12)', color: 'var(--status-blue)' }
  if (status === 'quoting') return { backgroundColor: 'var(--pill-awaiting-bg)', color: 'var(--pill-awaiting-text)' }
  if (status === 'complete') return { backgroundColor: 'var(--bg-elevated)', color: 'var(--text-secondary)' }
  return { backgroundColor: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const ATTENTION_BUCKETS: { key: JobAttention; label: string }[] = [
  { key: 'needs_you', label: '🔥 Needs You' },
  { key: 'waiting', label: '⏳ Waiting' },
  { key: 'ai_working', label: '🤖 AI Working' },
  { key: 'ready', label: '✅ Ready' },
  { key: 'in_progress', label: '🏗️ In Progress' },
]

function JobRow({ job, isFirst, onOpenJob }: { job: JobListItem; isFirst: boolean; onOpenJob: JobListCardProps['onOpenJob'] }) {
  return (
    <button
      type="button"
      onClick={() => onOpenJob(job.id, job.address, job.status, job.client_name)}
      className="w-full flex items-center justify-between px-4 py-3 text-left transition-colors"
      style={{
        borderTop: isFirst ? 'none' : '0.5px solid var(--bg-border)',
        backgroundColor: 'transparent',
      }}
      onMouseOver={(e) => { e.currentTarget.style.backgroundColor = 'var(--bg-elevated)' }}
      onMouseOut={(e) => { e.currentTarget.style.backgroundColor = 'transparent' }}
    >
      <div className="min-w-0 flex-1 pr-3">
        <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{job.address}</p>
        <div className="flex items-center gap-2 mt-0.5">
          {job.client_name && (
            <span className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{job.client_name}</span>
          )}
          {job.job_ref && (
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{job.job_ref}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <span
          className="text-xs font-medium px-2 py-0.5 rounded"
          style={statusStyle(job.status)}
        >
          {capitalize(job.status)}
        </span>
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true" style={{ color: 'var(--text-tertiary)' }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>
    </button>
  )
}

function JobGroup({ jobs, onOpenJob }: { jobs: JobListItem[]; onOpenJob: JobListCardProps['onOpenJob'] }) {
  return (
    <div
      className="overflow-hidden"
      style={{ borderRadius: 6, border: '0.5px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)' }}
    >
      {jobs.map((job, i) => (
        <JobRow key={job.id} job={job} isFirst={i === 0} onOpenJob={onOpenJob} />
      ))}
    </div>
  )
}

export default function JobListCard({ jobs, onOpenJob }: JobListCardProps) {
  // Only bucket when every job carries an attention tag — call sites that
  // don't compute it (disambiguation pickers) fall back to a flat list.
  const canGroup = jobs.length > 0 && jobs.every((j) => j.attention != null)

  if (!canGroup) {
    return (
      <div className="mt-2">
        <JobGroup jobs={jobs} onOpenJob={onOpenJob} />
      </div>
    )
  }

  const grouped = ATTENTION_BUCKETS
    .map((bucket) => ({ ...bucket, jobs: jobs.filter((j) => j.attention === bucket.key) }))
    .filter((bucket) => bucket.jobs.length > 0)

  return (
    <div className="mt-2 flex flex-col gap-3">
      {grouped.map((bucket) => (
        <div key={bucket.key}>
          <div className="text-xs font-medium mb-1.5 px-0.5" style={{ color: 'var(--text-secondary)' }}>
            {bucket.label}
          </div>
          <JobGroup jobs={bucket.jobs} onOpenJob={onOpenJob} />
        </div>
      ))}
    </div>
  )
}
