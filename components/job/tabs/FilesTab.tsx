'use client'

import type { JobSnapshot } from '@/lib/job-snapshot-demo'

interface FilesTabProps {
  files: JobSnapshot['files']
  onUploadPlans?: () => void
}

function intakeStatusLabel(status: string): string {
  switch (status) {
    case 'pending': return 'Pending'
    case 'processing': return 'Processing'
    case 'extracted': return 'Extracted'
    case 'failed': return 'Failed'
    default: return status
  }
}

function intakeStatusStyle(status: string): React.CSSProperties {
  switch (status) {
    case 'extracted': return { color: 'var(--status-green)' }
    case 'processing': return { color: 'var(--status-amber)' }
    case 'failed': return { color: 'var(--status-red)' }
    default: return { color: 'var(--text-tertiary)' }
  }
}

export default function FilesTab({ files, onUploadPlans }: FilesTabProps) {
  const count = files.length

  return (
    <div style={{ padding: '16px' }} className="space-y-3">
      {count > 0 && (
        <p className="text-[12px] font-medium" style={{ color: 'var(--text-tertiary)' }}>
          {count} file{count !== 1 ? 's' : ''}
        </p>
      )}

      {count === 0 && (
        <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>No files yet</p>
      )}

      {count > 0 && (
        <ul className="space-y-1.5">
          {files.map((file) => (
            <li
              key={file.id}
              className="flex items-center gap-3 rounded-[6px]"
              style={{ backgroundColor: 'var(--bg-surface)', border: '0.5px solid var(--bg-border)', padding: '10px 12px' }}
            >
              <div className="flex-shrink-0 w-7 h-7 rounded-[4px] flex items-center justify-center"
                style={{ backgroundColor: 'var(--bg-elevated)' }}>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}
                  style={{ color: 'var(--text-tertiary)' }} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-medium truncate" style={{ color: 'var(--text-primary)' }} title={file.filename}>{file.filename}</p>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                  Uploaded {file.uploaded_at} ·{' '}
                  <span style={intakeStatusStyle(file.intake_status)}>{intakeStatusLabel(file.intake_status)}</span>
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={onUploadPlans}
        className="inline-flex items-center gap-1.5 text-[12px] font-medium"
        style={{ color: 'var(--orange-primary)' }}
      >
        Upload plans
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
      </button>
    </div>
  )
}
