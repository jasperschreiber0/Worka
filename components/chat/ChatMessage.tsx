'use client'

import MorningBriefCard, { type Alert } from './MorningBriefCard'
import DuplicateWarning from './DuplicateWarning'
import VariationCard, { type VariationCardVariation } from './VariationCard'
import MarginCard, { type MarginJob } from './MarginCard'
import StateUpdateCard from './StateUpdateCard'
import JobListCard from './JobListCard'
import WorkerListCard, { type WorkerListItem } from './WorkerListCard'
import type { StateChange, JobListItem } from '@/app/api/chat/route'

// ─── Lightweight markdown renderer ───────────────────────────────────────────

function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const regex = /\*\*(.+?)\*\*/g
  let last = 0
  let match
  let key = 0
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    parts.push(<strong key={key++} className="font-semibold">{match[1]}</strong>)
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export function MarkdownContent({ text }: { text: string }) {
  const lines = text.split('\n')
  const nodes: React.ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // Blank line → spacer
    if (trimmed === '') {
      i++
      continue
    }

    // Collect a run of bullet lines
    if (trimmed.startsWith('• ') || trimmed.startsWith('- ')) {
      const items: string[] = []
      while (i < lines.length) {
        const t = lines[i].trim()
        if (t.startsWith('• ') || t.startsWith('- ')) {
          items.push(t.slice(2))
          i++
        } else {
          break
        }
      }
      nodes.push(
        <ul key={`ul-${i}`} className="list-disc pl-4 space-y-0.5 my-1">
          {items.map((item, idx) => (
            <li key={idx} className="text-[13px] leading-snug" style={{ color: 'var(--text-primary)' }}>{renderInline(item)}</li>
          ))}
        </ul>
      )
      continue
    }

    // Numbered list
    if (/^\d+\.\s/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length) {
        const t = lines[i].trim()
        if (/^\d+\.\s/.test(t)) {
          items.push(t.replace(/^\d+\.\s/, ''))
          i++
        } else {
          break
        }
      }
      nodes.push(
        <ol key={`ol-${i}`} className="list-decimal pl-4 space-y-0.5 my-1">
          {items.map((item, idx) => (
            <li key={idx} className="text-[13px] leading-snug" style={{ color: 'var(--text-primary)' }}>{renderInline(item)}</li>
          ))}
        </ol>
      )
      continue
    }

    // Checkbox items (□)
    if (trimmed.startsWith('□ ') || trimmed.startsWith('✓ ') || trimmed.startsWith('⚠ ')) {
      const items: string[] = []
      while (i < lines.length) {
        const t = lines[i].trim()
        if (t.startsWith('□ ') || t.startsWith('✓ ') || t.startsWith('⚠ ')) {
          items.push(t)
          i++
        } else {
          break
        }
      }
      nodes.push(
        <ul key={`cb-${i}`} className="space-y-1 my-1">
          {items.map((item, idx) => (
            <li key={idx} className="flex items-start gap-1.5 text-[13px] leading-snug" style={{ color: 'var(--text-primary)' }}>
              <span className={item.startsWith('✓') ? 'text-green-500' : item.startsWith('⚠') ? 'text-amber-400' : 'text-[#555555]'}>{item.charAt(0)}</span>
              <span>{renderInline(item.slice(2))}</span>
            </li>
          ))}
        </ul>
      )
      continue
    }

    // Regular paragraph line
    nodes.push(
      <p key={`p-${i}`} className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>{renderInline(trimmed)}</p>
    )
    i++
  }

  return <div className="space-y-1.5">{nodes}</div>
}

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
  variation?: VariationCardVariation
  marginJobs?: MarginJob[]
  jobList?: JobListItem[]
  workerList?: WorkerListItem[]
  stateChanges?: StateChange[]
  timestamp: Date
}

interface ChatMessageProps {
  message: Message
  builderId?: string
  onOpenJob?: (jobId: string) => void
  onOpenJobFromList?: (jobId: string, address: string, status: string, clientName?: string) => void
  onCreateAnyway?: (address: string) => void
  onAction?: (action: string, entityId?: string, entityType?: string) => void
  onVariationApprove?: (variationId: string) => void
  onVariationReject?: (variationId: string) => void
  onOpenMarginJob?: (jobId: string) => void
  onAssignWorkerTask?: (workerName: string) => void
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

export default function ChatMessage({ message, builderId = '00000000-0000-0000-0000-000000000001', onOpenJob, onOpenJobFromList, onCreateAnyway, onAction, onVariationApprove, onVariationReject, onOpenMarginJob, onAssignWorkerTask }: ChatMessageProps) {
  const isUser = message.role === 'user'
  const hasAlerts = message.alerts && message.alerts.length > 0
  const hasDuplicate = !!message.duplicateJob
  const hasVariation = !!message.variation
  const hasMarginJobs = !!message.marginJobs && message.marginJobs.length > 0

  if (isUser) {
    return (
      <div className="flex items-start gap-2.5 mb-5" role="listitem">
        {/* YOU avatar */}
        <div
          className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
          style={{ backgroundColor: 'var(--bg-elevated)' }}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true" style={{ color: 'var(--text-tertiary)' }}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p
            className="text-[10px] font-medium uppercase tracking-[0.08em] mb-1"
            style={{ color: 'var(--text-tertiary)' }}
          >
            YOU
          </p>
          <p
            className="text-[13px] italic leading-[1.5] whitespace-pre-wrap break-words"
            style={{ color: 'var(--text-secondary)' }}
          >
            {message.content}
          </p>
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {relativeTime(message.timestamp)}
          </p>
        </div>
      </div>
    )
  }

  // Assistant message with alerts → render MorningBriefCard
  if (hasAlerts && message.alerts) {
    return (
      <div className="flex items-start gap-2.5 mb-5" role="listitem">
        <div
          className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-semibold"
          style={{ backgroundColor: 'var(--orange-subtle)', color: 'var(--orange-primary)' }}
        >
          W
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-[0.08em] mb-1" style={{ color: 'var(--text-tertiary)' }}>WORKA</p>
          <MorningBriefCard message={message.content} alerts={message.alerts} onAction={onAction} />
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
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
      <div className="flex items-start gap-2.5 mb-5" role="listitem">
        <div
          className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-semibold"
          style={{ backgroundColor: 'var(--orange-subtle)', color: 'var(--orange-primary)' }}
        >
          W
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-[0.08em] mb-1" style={{ color: 'var(--text-tertiary)' }}>WORKA</p>
          <MarkdownContent text={message.content} />
          {message.stateChanges && message.stateChanges.length > 0 && (
            <StateUpdateCard changes={message.stateChanges} />
          )}
          {onOpenJob && onCreateAnyway && (
            <DuplicateWarning
              existingJob={dup}
              onOpenJob={onOpenJob}
              onCreateAnyway={onCreateAnyway}
            />
          )}
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {relativeTime(message.timestamp)}
          </p>
        </div>
      </div>
    )
  }

  // Assistant message with variation card
  if (hasVariation && message.variation) {
    const v = message.variation
    return (
      <div className="flex items-start gap-2.5 mb-5" role="listitem">
        <div
          className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-semibold"
          style={{ backgroundColor: 'var(--orange-subtle)', color: 'var(--orange-primary)' }}
        >
          W
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-[0.08em] mb-1" style={{ color: 'var(--text-tertiary)' }}>WORKA</p>
          <MarkdownContent text={message.content} />
          <VariationCard
            variation={v}
            onApprove={onVariationApprove ?? (() => {})}
            onReject={onVariationReject ?? (() => {})}
            onViewJob={onOpenJob}
          />
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {relativeTime(message.timestamp)}
          </p>
        </div>
      </div>
    )
  }

  // Assistant message with margin jobs
  if (hasMarginJobs && message.marginJobs) {
    return (
      <div className="flex items-start gap-2.5 mb-5" role="listitem">
        <div
          className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-semibold"
          style={{ backgroundColor: 'var(--orange-subtle)', color: 'var(--orange-primary)' }}
        >
          W
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-[0.08em] mb-1" style={{ color: 'var(--text-tertiary)' }}>WORKA</p>
          <MarkdownContent text={message.content} />
          <MarginCard
            jobs={message.marginJobs}
            onOpenJob={onOpenMarginJob ?? onOpenJob}
          />
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {relativeTime(message.timestamp)}
          </p>
        </div>
      </div>
    )
  }

  // Assistant message without alerts → plain text (+ optional job/worker list)
  return (
    <div className="flex items-start gap-2.5 mb-5" role="listitem">
      <div
        className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-semibold"
        style={{ backgroundColor: 'var(--orange-subtle)', color: 'var(--orange-primary)' }}
      >
        W
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-[0.08em] mb-1" style={{ color: 'var(--text-tertiary)' }}>WORKA</p>
        <MarkdownContent text={message.content} />
        {message.jobList && message.jobList.length > 0 && onOpenJobFromList && (
          <JobListCard jobs={message.jobList} onOpenJob={onOpenJobFromList} />
        )}
        {message.workerList && message.workerList.length > 0 && (
          <WorkerListCard
            workers={message.workerList}
            builderId={builderId}
            onAssignTask={onAssignWorkerTask}
          />
        )}
        {message.stateChanges && message.stateChanges.length > 0 && (
          <StateUpdateCard changes={message.stateChanges} />
        )}
        <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
          {relativeTime(message.timestamp)}
        </p>
      </div>
    </div>
  )
}
