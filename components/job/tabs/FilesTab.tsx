'use client'

import type { JobSnapshot } from '@/lib/job-snapshot-demo'

// ─── Props ────────────────────────────────────────────────────────────────────

interface FilesTabProps {
  files: JobSnapshot['files']
  onUploadPlans?: () => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function intakeStatusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Pending'
    case 'processing':
      return 'Processing'
    case 'extracted':
      return 'Extracted'
    case 'failed':
      return 'Failed'
    default:
      return status
  }
}

function intakeStatusClass(status: string): string {
  switch (status) {
    case 'extracted':
      return 'text-green-600'
    case 'processing':
      return 'text-amber-600'
    case 'failed':
      return 'text-red-600'
    default:
      return 'text-slate-500'
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function FilesTab({ files, onUploadPlans }: FilesTabProps) {
  const count = files.length

  if (count === 0) {
    return (
      <div className="p-4 space-y-4">
        <p className="text-sm text-slate-500">No files yet</p>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors"
          onClick={onUploadPlans}
        >
          Upload plans
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-3">
      <p className="text-sm font-medium text-slate-700">
        {count} file{count !== 1 ? 's' : ''}
      </p>

      <ul className="space-y-2">
        {files.map((file) => (
          <li
            key={file.id}
            className="bg-white border border-slate-200 rounded-lg px-3 py-3 flex items-center gap-3 shadow-sm"
          >
            {/* File icon */}
            <div className="flex-shrink-0 w-8 h-8 rounded-md bg-slate-100 flex items-center justify-center">
              <svg
                className="w-4 h-4 text-slate-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                />
              </svg>
            </div>

            {/* File details */}
            <div className="min-w-0 flex-1">
              <p className="text-sm text-slate-800 font-medium truncate">{file.filename}</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Uploaded {file.uploaded_at} &middot;{' '}
                <span className={intakeStatusClass(file.intake_status)}>
                  {intakeStatusLabel(file.intake_status)}
                </span>
              </p>
            </div>
          </li>
        ))}
      </ul>

      {/* Upload more */}
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors mt-1"
        onClick={() => {
          // Future session: trigger UploadPanel
        }}
      >
        Upload plans
        <svg
          className="w-3.5 h-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
      </button>
    </div>
  )
}
