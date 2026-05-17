'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import ChatMessage, { type Message, type DuplicateJob } from './ChatMessage'
import type { Alert } from './MorningBriefCard'
import WorkerModal from './WorkerModal'
import UploadPanel from './UploadPanel'
import AssumptionReview from './AssumptionReview'
import type { Worker, Job } from '@/lib/types/database.types'

// ─── API response type ────────────────────────────────────────────────────────

interface WorkerModalEvent {
  type: 'open_worker_modal'
  worker_id: string
}

interface UploadPanelEvent {
  type: 'open_upload_panel'
  job_id: string
}

interface DuplicateWarningEvent {
  type: 'show_duplicate_warning'
  job_id: string
}

interface ChatApiResponse {
  intent: string
  message: string
  alerts?: Alert[]
  worker?: Worker
  invite_url?: string
  job?: Job
  duplicate?: boolean
  existing_job?: Job
  event?: WorkerModalEvent | UploadPanelEvent | DuplicateWarningEvent | { type: string; [key: string]: unknown }
}

// ─── Worker modal state ───────────────────────────────────────────────────────

interface WorkerModalState {
  isOpen: boolean
  worker: Worker | null
  inviteUrl: string
}

// ─── Upload panel state ───────────────────────────────────────────────────────

interface UploadPanelState {
  isOpen: boolean
  job: Job | null
}

// ─── Assumption review state ──────────────────────────────────────────────────

type AssumptionReviewStateOrNull = { quoteId: string; jobAddress: string } | null

// ─── Unique ID helper ─────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasSentInitial, setHasSentInitial] = useState(false)
  const [workerModal, setWorkerModal] = useState<WorkerModalState>({
    isOpen: false,
    worker: null,
    inviteUrl: '',
  })
  const [uploadPanel, setUploadPanel] = useState<UploadPanelState>({
    isOpen: false,
    job: null,
  })
  const [reviewingAssumptions, setReviewingAssumptions] = useState<AssumptionReviewStateOrNull>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const handleCloseWorkerModal = useCallback(() => {
    setWorkerModal((prev) => ({ ...prev, isOpen: false }))
  }, [])

  const handleCloseUploadPanel = useCallback(() => {
    setUploadPanel((prev) => ({ ...prev, isOpen: false }))
  }, [])

  const handleIntakeComplete = useCallback(
    (quoteId: string, assumptionCount: number) => {
      setUploadPanel((prev) => ({ ...prev, isOpen: false }))

      const jobAddress = uploadPanel.job?.address ?? 'this job'
      const assistantMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: `Draft quote ready for ${jobAddress} — ${assumptionCount} assumption${assumptionCount !== 1 ? 's' : ''} need your review before you can send it.`,
        alerts: [
          {
            priority: 'high',
            message: `${assumptionCount} item${assumptionCount !== 1 ? 's' : ''} need your input before the quote is ready`,
            action: 'Review assumptions',
            entity_id: quoteId,
            entity_type: 'quote',
          },
        ],
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, assistantMessage])
    },
    [uploadPanel.job]
  )

  // Handler: action button clicked in MorningBriefCard or ChatMessage
  const handleAction = useCallback(
    (action: string, entityId?: string, _entityType?: string) => {
      if (action === 'Review assumptions') {
        const quoteId = entityId ?? 'demo-quote-id'
        // Try to find a job address from upload panel context, fall back to 'this job'
        const jobAddress = uploadPanel.job?.address ?? 'this job'
        setReviewingAssumptions({ quoteId, jobAddress })
      }
      // 'Chase payment' → Session 10
      // 'Follow up' → Session 12
      // Other actions → no-op
    },
    [uploadPanel.job]
  )

  // Handler: assumption review complete
  const handleAssumptionComplete = useCallback(
    (_allResolved: boolean) => {
      setReviewingAssumptions(null)
      const assistantMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: 'All assumptions resolved — draft quote is ready. You can now review and send it.',
        alerts: [
          {
            priority: 'low',
            message: 'Quote is ready to review',
            action: 'View draft quote',
          },
        ],
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, assistantMessage])
    },
    []
  )

  // Handler: assumption review dismissed mid-flow
  const handleAssumptionDismiss = useCallback(() => {
    setReviewingAssumptions(null)
    // Count remaining unresolved — for demo we always say items need input
    const assistantMessage: Message = {
      id: generateId(),
      role: 'assistant',
      content: 'Assumptions review paused. Some items still need your input before the quote can be sent.',
      timestamp: new Date(),
    }
    setMessages((prev) => [...prev, assistantMessage])
  }, [])

  // Auto-scroll to bottom when messages change
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, loading, scrollToBottom])

  // Send a message to the API
  const sendMessage = useCallback(async (text: string, forceCreate?: boolean) => {
    const trimmed = text.trim()
    if (!trimmed || loading) return

    // Add user message to state
    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: trimmed,
      timestamp: new Date(),
    }

    setMessages((prev) => [...prev, userMessage])
    setInput('')
    setLoading(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          builder_id: '00000000-0000-0000-0000-000000000001',
          ...(forceCreate ? { force_create: true } : {}),
        }),
      })

      const data: ChatApiResponse = await res.json()

      // Build assistant message — attach duplicateJob if relevant
      let duplicateJob: DuplicateJob | undefined
      if (
        data.event?.type === 'show_duplicate_warning' &&
        data.existing_job
      ) {
        duplicateJob = {
          id: data.existing_job.id,
          address: data.existing_job.address,
          status: data.existing_job.status,
        }
      }

      const assistantMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: data.message,
        alerts: data.alerts,
        duplicateJob,
        timestamp: new Date(),
      }

      setMessages((prev) => [...prev, assistantMessage])

      // Handle Layer 3 events
      if (
        data.event?.type === 'open_worker_modal' &&
        data.worker &&
        data.invite_url
      ) {
        setWorkerModal({
          isOpen: true,
          worker: data.worker,
          inviteUrl: data.invite_url,
        })
      }

      if (
        data.event?.type === 'open_upload_panel' &&
        data.job
      ) {
        setUploadPanel({
          isOpen: true,
          job: data.job,
        })
      }
    } catch {
      const errorMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: 'Something went wrong — please try again.',
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, errorMessage])
    } finally {
      setLoading(false)
    }
  }, [loading])

  // Handler: open an existing job (wired fully in Session 9)
  const handleOpenJob = useCallback((_jobId: string) => {
    // No-op for now — wired in Session 9
  }, [])

  // Handler: create job anyway (skip duplicate check)
  const handleCreateAnyway = useCallback(() => {
    sendMessage('create job anyway', true)
  }, [sendMessage])

  // On mount: auto-send "whats on today" to trigger morning brief
  useEffect(() => {
    if (!hasSentInitial) {
      setHasSentInitial(true)
      sendMessage('whats on today')
    }
  }, [hasSentInitial, sendMessage])

  // Handle form submit
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    sendMessage(input)
  }

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    // Reset height then set to scrollHeight so it shrinks when text is deleted
    e.target.style.height = 'auto'
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-white flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-brand-500 flex items-center justify-center flex-shrink-0">
            <svg
              className="w-4.5 h-4.5 text-white w-[18px] h-[18px]"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21"
              />
            </svg>
          </div>
          <span className="text-lg font-bold text-slate-900 tracking-tight">WorkA</span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-600 font-medium hidden sm:block">Dave Nguyen</span>
          {/* Avatar */}
          <div className="w-8 h-8 rounded-full bg-brand-100 border border-brand-200 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-semibold text-brand-700">DN</span>
          </div>
        </div>
      </header>

      {/* ── Messages ───────────────────────────────────────────────────────── */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto px-4 py-4"
        role="list"
        aria-label="Chat messages"
        aria-live="polite"
        aria-relevant="additions"
      >
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            onOpenJob={handleOpenJob}
            onCreateAnyway={handleCreateAnyway}
            onAction={handleAction}
          />
        ))}

        {/* Loading indicator */}
        {loading && (
          <div className="flex justify-start mb-4" role="status" aria-label="WorkA is thinking">
            <div className="bg-white border border-slate-200 shadow-sm rounded-2xl rounded-tl-sm px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-500">WorkA is thinking</span>
                <span className="flex items-center gap-0.5" aria-hidden="true">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Scroll anchor */}
        <div ref={messagesEndRef} />
      </div>

      {/* ── Worker Modal ───────────────────────────────────────────────────── */}
      {workerModal.worker && (
        <WorkerModal
          isOpen={workerModal.isOpen}
          onClose={handleCloseWorkerModal}
          worker={workerModal.worker}
          inviteUrl={workerModal.inviteUrl}
        />
      )}

      {/* ── Upload Panel ───────────────────────────────────────────────────── */}
      {uploadPanel.job && (
        <UploadPanel
          isOpen={uploadPanel.isOpen}
          onClose={handleCloseUploadPanel}
          job={{
            id: uploadPanel.job.id,
            address: uploadPanel.job.address,
            status: uploadPanel.job.status,
          }}
          onIntakeComplete={handleIntakeComplete}
        />
      )}

      {/* ── Assumption Review ──────────────────────────────────────────────── */}
      {reviewingAssumptions && (
        <AssumptionReview
          quoteId={reviewingAssumptions.quoteId}
          builderId="00000000-0000-0000-0000-000000000001"
          jobAddress={reviewingAssumptions.jobAddress}
          onComplete={handleAssumptionComplete}
          onDismiss={handleAssumptionDismiss}
        />
      )}

      {/* ── Input ──────────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-t border-slate-200 bg-white px-4 py-3 pb-safe">
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <label htmlFor="chat-input" className="sr-only">
            Type a message
          </label>
          <textarea
            ref={inputRef}
            id="chat-input"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask something — e.g. 'whats on today'"
            rows={1}
            disabled={loading}
            className="flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent transition-shadow duration-150 disabled:opacity-50 disabled:cursor-not-allowed leading-relaxed overflow-hidden"
            style={{ minHeight: '38px', maxHeight: '120px' }}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="flex-shrink-0 btn-primary px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Send message"
          >
            Send
          </button>
        </form>
        <p className="mt-1.5 text-xs text-slate-400">
          Press <kbd className="font-mono text-xs bg-slate-100 border border-slate-200 rounded px-1">Enter</kbd> to send
          &nbsp;&middot;&nbsp;
          <kbd className="font-mono text-xs bg-slate-100 border border-slate-200 rounded px-1">Shift+Enter</kbd> for new line
        </p>
      </div>
    </div>
  )
}
