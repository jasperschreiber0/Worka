'use client'

import MorningBriefCard, { type Alert } from './MorningBriefCard'
import DuplicateWarning from './DuplicateWarning'
import VariationCard, { type VariationCardVariation } from './VariationCard'
import MarginCard, { type MarginJob } from './MarginCard'
import StateUpdateCard from './StateUpdateCard'
import JobListCard from './JobListCard'
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
            <li key={idx} className="text-sm text-slate-800 leading-snug">{renderInline(item)}</li>
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
            <li key={idx} className="text-sm text-slate-800 leading-snug">{renderInline(item)}</li>
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
            <li key={idx} className="flex items-start gap-1.5 text-sm text-slate-800 leading-snug">
              <span className={item.startsWith('✓') ? 'text-green-600' : item.startsWith('⚠') ? 'text-amber-500' : 'text-slate-400'}>{item.charAt(0)}</span>
              <span>{renderInline(item.slice(2))}</span>
            </li>
          ))}
        </ul>
      )
      continue
    }

    // Regular paragraph line
    nodes.push(
      <p key={`p-${i}`} className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">{renderInline(trimmed)}</p>
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
  stateChanges?: StateChange[]
  timestamp: Date
}

interface ChatMessageProps {
  message: Message
  onOpenJob?: (jobId: string) => void
  onOpenJobFromList?: (jobId: string, address: string, status: string, clientName?: string) => void
  onCreateAnyway?: (address: string) => void
  onAction?: (action: string, entityId?: string, entityType?: string) => void
  onVariationApprove?: (variationId: string) => void
  onVariationReject?: (variationId: string) => void
  onOpenMarginJob?: (jobId: string) => void
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

export default function ChatMessage({ message, onOpenJob, onOpenJobFromList, onCreateAnyway, onAction, onVariationApprove, onVariationReject, onOpenMarginJob }: ChatMessageProps) {
  const isUser = message.role === 'user'
  const hasAlerts = message.alerts && message.alerts.length > 0
  const hasDuplicate = !!message.duplicateJob
  const hasVariation = !!message.variation
  const hasMarginJobs = !!message.marginJobs && message.marginJobs.length > 0

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
          <MorningBriefCard message={message.content} alerts={message.alerts} onAction={onAction} />
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
            <MarkdownContent text={message.content} />
          </div>
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
          <p className="text-xs text-slate-400 mt-1 px-1">
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
      <div className="flex justify-start mb-4" role="listitem">
        <div className="max-w-xs sm:max-w-md lg:max-w-lg w-full">
          <div className="rounded-2xl rounded-tl-sm px-4 py-2.5 bg-white border border-slate-200 shadow-sm">
            <MarkdownContent text={message.content} />
          </div>
          <VariationCard
            variation={v}
            onApprove={onVariationApprove ?? (() => {})}
            onReject={onVariationReject ?? (() => {})}
            onViewJob={onOpenJob}
          />
          <p className="text-xs text-slate-400 mt-1 px-1">
            {relativeTime(message.timestamp)}
          </p>
        </div>
      </div>
    )
  }

  // Assistant message with margin jobs
  if (hasMarginJobs && message.marginJobs) {
    return (
      <div className="flex justify-start mb-4" role="listitem">
        <div className="max-w-xs sm:max-w-md lg:max-w-lg w-full">
          <div className="rounded-2xl rounded-tl-sm px-4 py-2.5 bg-white border border-slate-200 shadow-sm">
            <MarkdownContent text={message.content} />
          </div>
          <MarginCard
            jobs={message.marginJobs}
            onOpenJob={onOpenMarginJob ?? onOpenJob}
          />
          <p className="text-xs text-slate-400 mt-1 px-1">
            {relativeTime(message.timestamp)}
          </p>
        </div>
      </div>
    )
  }

  // Assistant message without alerts → plain bubble (+ optional job list)
  return (
    <div className="flex justify-start mb-4" role="listitem">
      <div className="max-w-xs sm:max-w-md lg:max-w-lg w-full">
        <div className="rounded-2xl rounded-tl-sm px-4 py-2.5 bg-white border border-slate-200 shadow-sm">
          <MarkdownContent text={message.content} />
        </div>
        {message.jobList && message.jobList.length > 0 && onOpenJobFromList && (
          <JobListCard jobs={message.jobList} onOpenJob={onOpenJobFromList} />
        )}
        {message.stateChanges && message.stateChanges.length > 0 && (
          <StateUpdateCard changes={message.stateChanges} />
        )}
        <p className="text-xs text-slate-400 mt-1 px-1">
          {relativeTime(message.timestamp)}
        </p>
      </div>
    </div>
  )
}
