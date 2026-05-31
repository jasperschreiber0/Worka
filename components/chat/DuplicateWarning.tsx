'use client'

import { useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function capitalise(str: string): string {
  if (!str) return str
  return str.charAt(0).toUpperCase() + str.slice(1)
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function DuplicateWarning({
  existingJob,
  onOpenJob,
  onCreateAnyway,
}: DuplicateWarningProps) {
  const handleOpenJob = useCallback(() => {
    onOpenJob(existingJob.id)
  }, [existingJob.id, onOpenJob])

  const handleCreateAnyway = useCallback(() => {
    onCreateAnyway(existingJob.address)
  }, [existingJob.address, onCreateAnyway])

  return (
    <div
      className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4"
      role="alert"
      aria-label="Duplicate job warning"
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        {/* Warning icon */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className="text-amber-600 flex-shrink-0"
        >
          <path
            d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M12 9v4M12 17h.01"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <p className="text-sm font-semibold text-amber-800">Job already exists</p>
      </div>

      {/* Body */}
      <p className="text-sm text-amber-700 mb-3">
        You have an existing job at this address:
      </p>

      {/* Job card */}
      <div className="rounded-lg bg-white border border-amber-200 px-3 py-3 mb-4">
        <div className="flex items-start gap-2">
          {/* Location pin icon */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="text-amber-500 mt-0.5 flex-shrink-0"
          >
            <path
              d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle
              cx="12"
              cy="9"
              r="2.5"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
          <div>
            <p className="text-sm font-semibold text-slate-800 leading-tight">
              {existingJob.address}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Status:{' '}
              <span className="font-medium text-amber-700">
                {capitalise(existingJob.status)}
              </span>
            </p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleOpenJob}
          className="flex-1 px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium transition-colors text-center"
        >
          Open existing job
        </button>
        <button
          onClick={handleCreateAnyway}
          className="flex-1 px-3 py-2 rounded-lg bg-white border border-amber-300 hover:bg-amber-50 text-amber-800 text-sm font-medium transition-colors text-center"
        >
          Create new job
        </button>
      </div>
    </div>
  )
}
