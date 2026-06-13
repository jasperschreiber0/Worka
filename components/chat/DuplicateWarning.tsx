'use client'

import { useCallback } from 'react'

export interface DuplicateWarningJob {
  id: string
  address: string
  status: string
}

export interface DuplicateWarningProps {
  existingJob: DuplicateWarningJob
  onOpenJob: (jobId: string) => void
  onCreateAnyway: (address: string) => void
}

function capitalise(str: string): string {
  if (!str) return str
  return str.charAt(0).toUpperCase() + str.slice(1)
}

export default function DuplicateWarning({ existingJob, onOpenJob, onCreateAnyway }: DuplicateWarningProps) {
  const handleOpenJob = useCallback(() => onOpenJob(existingJob.id), [existingJob.id, onOpenJob])
  const handleCreateAnyway = useCallback(() => onCreateAnyway(existingJob.address), [existingJob.address, onCreateAnyway])

  return (
    <div
      className="mt-3 rounded-[6px] px-3 py-3"
      role="alert"
      aria-label="Duplicate job warning"
      style={{ backgroundColor: 'rgba(255,152,0,0.08)', border: '0.5px solid rgba(255,152,0,0.3)' }}
    >
      <div className="flex items-center gap-2 mb-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ color: 'var(--status-amber)', flexShrink: 0 }}>
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M12 9v4M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <p className="text-[12px] font-semibold" style={{ color: 'var(--status-amber)' }}>Job already exists</p>
      </div>

      <p className="text-[12px] mb-2" style={{ color: 'var(--text-secondary)' }}>You have an existing job at this address:</p>

      <div className="rounded-[4px] px-3 py-2.5 mb-3 flex items-start gap-2"
        style={{ backgroundColor: 'var(--bg-elevated)', border: '0.5px solid var(--bg-border)' }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="mt-0.5 flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="12" cy="9" r="2.5" stroke="currentColor" strokeWidth="2" />
        </svg>
        <div>
          <p className="text-[12px] font-semibold leading-tight" style={{ color: 'var(--text-primary)' }}>{existingJob.address}</p>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
            Status: <span style={{ color: 'var(--status-amber)', fontWeight: 500 }}>{capitalise(existingJob.status)}</span>
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button onClick={handleOpenJob}
          className="flex-1 px-3 py-2 rounded-[4px] text-[12px] font-semibold"
          style={{ backgroundColor: 'var(--orange-primary)', color: '#fff' }}>
          Open existing job
        </button>
        <button onClick={handleCreateAnyway}
          className="flex-1 px-3 py-2 rounded-[4px] text-[12px] font-medium"
          style={{ backgroundColor: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '0.5px solid var(--bg-border)' }}>
          Create new job
        </button>
      </div>
    </div>
  )
}
