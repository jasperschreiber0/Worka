'use client'

import MorningBriefCard, { type Alert } from './MorningBriefCard'
import DuplicateWarning from './DuplicateWarning'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DuplicateJob {
  id: string
  address: string
  status: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  alerts?: Alert[]
  duplicateJob?: DuplicateJob
  timestamp: Date
}

interface ChatMessageProps {
  message: Message
  onOpenJob?: (jobId: string) => void
  onCreateAnyway?: () => void
}

// ─── Relative time helper ─────────────────────────────────────────────────────

function relativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)

  if (diffSec < 10) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffMin === 1) return '1 min ago'
  if (diffMin < 60) return `${diffMin} min ago`

  const diffHours = Math.floor(diffMin / 60)
  if (diffHours === 1) return '1 hour ago'
  if (diffHours < 24) return `${diffHours} hours ago`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'yesterday'
  return `${diffDays} days ago`
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ChatMessage({ message, onOpenJob, onCreateAnyway }: ChatMessageProps) {
  const isUser = message.role === 'user'
  const hasAlerts = message.alerts && message.alerts.length > 0
  const hasDuplicate = !!message.duplicateJob

  if (isUser) {
    return (
      <div className="flex justify-end mb-4" role="listitem">
        <div className="max-w-xs sm:max-w-md lg:max-w-lg">
          <div className="rounded-2xl rounded-tr-sm px-4 py-2.5 bg-brand-500 text-white">
            <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
              {message.content}
            </p>
          </div>
          <p className="text-xs text-slate-400 text-right mt-1 px-1">
            {relativeTime(message.timestamp)}
          </p>
        </div>
      </div>
    )
  }

  // Assistant message with alerts → render MorningBriefCard
  if (hasAlerts && message.alerts) {
    return (
      <div className="flex justify-start mb-4" role="listitem">
        <div className="max-w-sm sm:max-w-lg lg:max-w-xl w-full">
          <MorningBriefCard message={message.content} alerts={message.alerts} />
          <p className="text-xs text-slate-400 mt-1 px-1">
            {relativeTime(message.timestamp)}
          </p>
        </div>
      </div>
    )
  }

  // Assistant message with duplicate warning
  if (hasDuplicate && message.duplicateJob) {
    const dup = message.duplicateJob
    return (
      <div className="flex justify-start mb-4" role="listitem">
        <div className="max-w-xs sm:max-w-md lg:max-w-lg w-full">
          <div className="rounded-2xl rounded-tl-sm px-4 py-2.5 bg-white border border-slate-200 shadow-sm">
            <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap break-words">
              {message.content}
            </p>
          </div>
          {onOpenJob && onCreateAnyway && (
            <DuplicateWarning
              existingJob={dup}
              onOpenJob={onOpenJob}
              onCreateAnyway={onCreateAnyway}
            />
          )}
          <p className="text-xs text-slate-400 mt-1 px-1">
            {relativeTime(message.timestamp)}
          </p>
        </div>
      </div>
    )
  }

  // Assistant message without alerts → plain bubble
  return (
    <div className="flex justify-start mb-4" role="listitem">
      <div className="max-w-xs sm:max-w-md lg:max-w-lg">
        <div className="rounded-2xl rounded-tl-sm px-4 py-2.5 bg-white border border-slate-200 shadow-sm">
          <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap break-words">
            {message.content}
          </p>
        </div>
        <p className="text-xs text-slate-400 mt-1 px-1">
          {relativeTime(message.timestamp)}
        </p>
      </div>
    </div>
  )
}
