'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import ChatMessage, { type Message, type DuplicateJob } from './ChatMessage'
import type { Alert } from './MorningBriefCard'
import WorkerModal from './WorkerModal'
import UploadPanel from './UploadPanel'
import AssumptionReview from './AssumptionReview'
import QuoteView from '@/components/quote/QuoteView'
import VariationNotificationModal from './VariationNotificationModal'
import EmailDraftModal, { type EmailIntentHint } from './EmailDraftModal'
import InboundEmailAlert, { type InboundEmailAlertProps } from './InboundEmailAlert'
import type { VariationCardVariation } from './VariationCard'
import type { Worker, Job } from '@/lib/types/database.types'
import type { DemoVariation } from '@/lib/variations-demo'
import ActivationModal, { type ActivationResult } from '@/components/job/ActivationModal'
import type { MarginJob } from './MarginCard'

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

interface OpenJobSnapshotEvent {
  type: 'open_job_snapshot'
  job_id: string
  job_address: string
  job_status: string
  client_name?: string
}

interface ShowVariationEvent {
  type: 'show_variation'
  variation_id: string
  job_id: string
}

interface OpenEmailDraftEvent {
  type: 'open_email_draft'
  job_id: string | null
  recipient_name: string | null
  intent_hint: string
}

interface SuggestEmailDraftEvent {
  type: 'suggest_email_draft'
  job_id: string
  intent_hint: string
}

interface InboundEmailAlertEvent {
  type: 'inbound_email_alert'
  email: {
    from: string
    subject: string
    preview: string
    received_display: string
  }
  job_address: string
  intent: string
  suggested_action: {
    type: string
    description: string
    draft?: { subject: string; body: string }
  } | null
}

interface SuggestJobActivationEvent {
  type: 'suggest_job_activation'
  job_id: string
  quote_id: string
}

interface PickJobForTaskEvent {
  type: 'pick_job_for_task'
  task_description: string
  jobs: Array<{ id: string; address: string; status: string }>
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
  variation?: DemoVariation
  all_variations?: DemoVariation[]
  margin_jobs?: MarginJob[]
  job_list?: import('@/app/api/chat/route').JobListItem[]
  worker_list?: import('@/app/api/chat/route').WorkerListItem[]
  state_changes?: import('@/app/api/chat/route').StateChange[]
  event?: WorkerModalEvent | UploadPanelEvent | DuplicateWarningEvent | OpenJobSnapshotEvent | ShowVariationEvent | OpenEmailDraftEvent | SuggestEmailDraftEvent | InboundEmailAlertEvent | SuggestJobActivationEvent | PickJobForTaskEvent | { type: string; [key: string]: unknown }
  events?: Array<WorkerModalEvent | UploadPanelEvent | DuplicateWarningEvent | OpenJobSnapshotEvent | ShowVariationEvent | OpenEmailDraftEvent | SuggestEmailDraftEvent | InboundEmailAlertEvent | SuggestJobActivationEvent | PickJobForTaskEvent | { type: string; [key: string]: unknown }>
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
  job: ActiveJobRef | null
}

// ─── Assumption review state ──────────────────────────────────────────────────

type AssumptionReviewStateOrNull = {
  quoteId: string
  jobAddress: string
  similarProjects?: import('@/lib/types/estimation.types').SimilarProject[]
  scopeHints?: import('@/lib/types/estimation.types').ScopeHint[]
  totalInMemory?: number
} | null

// ─── Quote view state ─────────────────────────────────────────────────────────

type QuoteViewStateOrNull = { quoteId: string } | null

// ─── Unique ID helper ─────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface ActiveJobRef {
  id: string
  address: string
  status: string
  client_name?: string
}

export interface PendingEmailDraft {
  jobId: string
  intentHint: EmailIntentHint
  recipientName?: string
}

interface ChatInterfaceProps {
  builderId?: string
  userName?: string
  userInitials?: string
  isDemo?: boolean
  onJobMention?: (job: ActiveJobRef) => void
  onGeneralQuery?: () => void
  initialQuoteId?: string | null
  onInitialQuoteConsumed?: () => void
  pendingEmailDraft?: PendingEmailDraft | null
  onPendingEmailDraftConsumed?: () => void
  pendingUpload?: ActiveJobRef | null
  onPendingUploadConsumed?: () => void
  autoMessage?: string | null
  onAutoMessageConsumed?: () => void
  pendingFillInput?: string | null
  onFillInputConsumed?: () => void
  activeJobAddress?: string | null
  pendingFiles?: File[] | null
  onPendingFilesConsumed?: () => void
  droppedFiles?: Array<{ file: File; type: string; label: string }>
  onDroppedFilesConsumed?: () => void
}

// ─── Sign-out button ──────────────────────────────────────────────────────────

function SignOutButton({ isDemo }: { isDemo: boolean }) {
  const router = useRouter()

  async function handleSignOut() {
    if (isDemo) {
      router.push('/login')
      return
    }
    try {
      const { createClientComponentClient } = await import('@supabase/auth-helpers-nextjs')
      const supabase = createClientComponentClient()
      await supabase.auth.signOut()
      router.push('/login')
      router.refresh()
    } catch {
      router.push('/login')
    }
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      className="w-full px-3 py-2 text-sm text-left text-[#999999] hover:bg-[#2a2a2a] hover:text-[#e0e0e0] transition-colors flex items-center gap-2"
    >
      <svg className="w-4 h-4 text-[#555555]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15M12 9l-3 3m0 0 3 3m-3-3h12.75" />
      </svg>
      Sign out
    </button>
  )
}

// ─── DroppedFileBar ──────────────────────────────────────────────────────────

interface DroppedFileBarProps {
  files: Array<{ file: File; type: string; label: string }>
  jobs: Array<{ id: string; address: string; status: string }>
  jobQuery: string
  onJobQueryChange: (q: string) => void
  onSelectJob: (job: { id: string; address: string; status: string }) => void
  onDismiss: () => void
}

function DroppedFileBar({ files, jobs, jobQuery, onJobQueryChange, onSelectJob, onDismiss }: DroppedFileBarProps) {
  const filteredJobs = jobs
    .filter(j => jobQuery === '' || j.address.toLowerCase().includes(jobQuery.toLowerCase()))
    .slice(0, 5)

  return (
    <div className="mb-2 bg-[#222222] border border-[#2e2e2e] rounded-[4px] p-2">
      {/* File chips */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {files.map((f, i) => (
          <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[3px] bg-[#2a2a2a] border border-[#2e2e2e] text-xs text-[#999999]">
            <span className="font-medium text-[#ff6b2b]">{f.label}</span>
            <span className="text-[#555555] truncate max-w-[120px]">{f.file.name}</span>
          </span>
        ))}
      </div>
      {/* Job search */}
      <p className="text-xs text-[#999999] mb-1">Which job are these for?</p>
      <input
        type="text"
        value={jobQuery}
        onChange={e => onJobQueryChange(e.target.value)}
        placeholder="Search by address…"
        className="w-full bg-[#2a2a2a] border border-[#2e2e2e] rounded-[4px] px-2.5 py-1.5 text-sm text-[#e0e0e0] placeholder:text-[#333333] focus:outline-none focus:border-[#ff6b2b]/50 mb-1.5"
      />
      {filteredJobs.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {filteredJobs.map(job => (
            <button
              key={job.id}
              type="button"
              onClick={() => onSelectJob(job)}
              className="text-left bg-[#2a2a2a] border border-[#2e2e2e] rounded-[4px] px-2 py-1 text-sm text-[#e0e0e0] hover:border-[#ff6b2b]/40 transition-colors"
            >
              {job.address}
              <span className="ml-2 text-xs text-[#555555]">{job.status}</span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="mt-1.5 text-xs text-[#555555] hover:text-[#999999] transition-colors"
      >
        Dismiss
      </button>
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

const DEMO_BUILDER_ID = '00000000-0000-0000-0000-000000000001'

export default function ChatInterface({
  builderId = DEMO_BUILDER_ID,
  userName = 'Dave Nguyen',
  userInitials = 'DN',
  isDemo = true,
  onJobMention,
  onGeneralQuery,
  initialQuoteId,
  onInitialQuoteConsumed,
  pendingEmailDraft,
  onPendingEmailDraftConsumed,
  pendingUpload,
  onPendingUploadConsumed,
  autoMessage,
  onAutoMessageConsumed,
  pendingFillInput,
  onFillInputConsumed,
  activeJobAddress,
  pendingFiles,
  onPendingFilesConsumed,
  droppedFiles,
  onDroppedFilesConsumed,
}: ChatInterfaceProps = {}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasSentInitial, setHasSentInitial] = useState(false)
  const [awaitingAddressForNewJob, setAwaitingAddressForNewJob] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [pendingTask, setPendingTask] = useState<{ description: string; jobs: Array<{ id: string; address: string; status: string }> } | null>(null)
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
  const [viewingQuote, setViewingQuote] = useState<QuoteViewStateOrNull>(null)
  const [activeVariationModal, setActiveVariationModal] = useState<{ variationId: string } | null>(null)
  const [emailDraftModal, setEmailDraftModal] = useState<{
    isOpen: boolean
    jobId?: string | null
    recipientName?: string
    intentHint?: EmailIntentHint
  } | null>(null)
  const [inboundEmailAlert, setInboundEmailAlert] = useState<Omit<InboundEmailAlertProps, 'onReply' | 'onDismiss'> | null>(null)
  const [chatActivationModal, setChatActivationModal] = useState<{
    isOpen: boolean
    jobId: string
    quoteId: string
    jobAddress: string
    quoteTotalCost: number
  } | null>(null)

  const [isListening, setIsListening] = useState(false)
  const recognitionRef = useRef<{ stop: () => void } | null>(null)
  const [pendingFilesForUpload, setPendingFilesForUpload] = useState<File[] | null>(null)
  const [lastResponseType, setLastResponseType] = useState<string | null>(null)

  const [pendingDropFiles, setPendingDropFiles] = useState<Array<{ file: File; type: string; label: string }>>([])
  const [dropJobQuery, setDropJobQuery] = useState<string>('')
  const [dropJobs, setDropJobs] = useState<Array<{ id: string; address: string; status: string }>>([])

  // When droppedFiles arrives from parent, consume and fetch jobs for quick-pick
  useEffect(() => {
    if (droppedFiles && droppedFiles.length > 0) {
      setPendingDropFiles(droppedFiles)
      onDroppedFilesConsumed?.()
      fetch('/api/jobs')
        .then(r => r.json())
        .then((data: { jobs?: Array<{ id: string; address: string; status: string }> }) => {
          setDropJobs(data.jobs ?? [])
        })
        .catch(() => setDropJobs([]))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedFiles])

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Focus input on mount so user can start typing immediately
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // When a quoteId is passed from the snapshot panel's "View quote" button,
  // open QuoteView immediately and notify the parent that we consumed it.
  useEffect(() => {
    if (initialQuoteId) {
      setViewingQuote({ quoteId: initialQuoteId })
      onInitialQuoteConsumed?.()
    }
  // We only want to react when initialQuoteId changes (not on every render)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuoteId])

  // When a pending email draft is passed from the snapshot panel's "Compose email" button,
  // inject it inline into the chat thread.
  useEffect(() => {
    if (pendingEmailDraft) {
      onPendingEmailDraftConsumed?.()
      void fetchAndInjectEmailDraft(
        pendingEmailDraft.jobId,
        pendingEmailDraft.recipientName ?? null,
        pendingEmailDraft.intentHint,
      )
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEmailDraft])

  // Open UploadPanel when a job's Files tab triggers "Upload plans"
  useEffect(() => {
    if (pendingUpload) {
      setUploadPanel({
        isOpen: true,
        job: {
          id: pendingUpload.id,
          address: pendingUpload.address,
          status: pendingUpload.status,
        },
      })
      onPendingUploadConsumed?.()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingUpload])

  // Fill input when "Add task" FAB is tapped from the job panel
  useEffect(() => {
    if (pendingFillInput) {
      setInput(pendingFillInput)
      onFillInputConsumed?.()
      setTimeout(() => {
        const ta = inputRef.current
        if (ta) {
          ta.focus()
          ta.setSelectionRange(ta.value.length, ta.value.length)
        }
      }, 50)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFillInput])

  // Files staged from homepage upload zone — ask for address, then open panel with files pre-loaded
  useEffect(() => {
    if (!pendingFiles || pendingFiles.length === 0) return
    const id = `msg-${Date.now()}-plans`
    setMessages((prev) => [
      ...prev,
      {
        id,
        role: 'assistant',
        content: "Got your plans — what's the address for this job?",
        timestamp: new Date(),
      },
    ])
    setAwaitingAddressForNewJob(true)
    setPendingFilesForUpload(pendingFiles)
    onPendingFilesConsumed?.()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFiles])

  const handleCloseWorkerModal = useCallback(() => {
    setWorkerModal((prev) => ({ ...prev, isOpen: false }))
  }, [])

  const handleCloseUploadPanel = useCallback(() => {
    setUploadPanel((prev) => ({ ...prev, isOpen: false }))
  }, [])

  const handleIntakeComplete = useCallback(
    (quoteId: string, assumptionCount: number, memoryData?: { similar_projects?: unknown[]; scope_hints?: unknown[]; total_in_memory?: number }) => {
      setUploadPanel((prev) => ({ ...prev, isOpen: false }))

      const jobAddress = uploadPanel.job?.address ?? 'this job'

      const memoryContext = memoryData?.similar_projects?.length
        ? ` Estimate informed by ${memoryData.similar_projects.length} similar historical project${memoryData.similar_projects.length !== 1 ? 's' : ''}.`
        : ''

      const assistantMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: `Draft quote ready for ${jobAddress} — ${assumptionCount} assumption${assumptionCount !== 1 ? 's' : ''} need your review before you can send it.${memoryContext}`,
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

      // Open assumption review immediately with memory context
      setReviewingAssumptions({
        quoteId,
        jobAddress,
        similarProjects: memoryData?.similar_projects as import('@/lib/types/estimation.types').SimilarProject[] | undefined,
        scopeHints: memoryData?.scope_hints as import('@/lib/types/estimation.types').ScopeHint[] | undefined,
        totalInMemory: memoryData?.total_in_memory,
      })
    },
    [uploadPanel.job]
  )


  // Handler: action button clicked in MorningBriefCard or ChatMessage
  const handleAction = useCallback(
    (action: string, entityId?: string, entityType?: string) => {
      if (action === 'Review assumptions') {
        const quoteId = entityId ?? 'demo-quote-id'
        // Try to find a job address from upload panel context, fall back to 'this job'
        const jobAddress = uploadPanel.job?.address ?? 'this job'
        setReviewingAssumptions({ quoteId, jobAddress })
        return
      }
      if (action === 'View draft quote') {
        const quoteId = entityId ?? 'demo-quote-id'
        setViewingQuote({ quoteId })
        return
      }
      if (action === 'Review variations') {
        // Defer until sendMessage is available via pendingAction
        setPendingAction('show me the variations')
        return
      }
      // Generic 'Open job' — entityId is the job_id from the alert
      if (action === 'Open job' && entityId) {
        onJobMention?.({ id: entityId, address: '', status: '' })
        return
      }
      // Generic 'Show jobs' — sends the jobs list message
      if (action === 'Show jobs') {
        void sendMessage('show my jobs')
        return
      }
      // 'Chase payment' from morning brief (overdue invoice on Fitzroy job)
      if (action === 'Chase payment') {
        void fetchAndInjectEmailDraft('00000000-0000-0000-0000-000000000010', 'the Hendersons', 'invoice')
        return
      }
      // 'Follow up' from morning brief (Toorak quote stale)
      if (action === 'Follow up') {
        void fetchAndInjectEmailDraft('00000000-0000-0000-0000-000000000020', 'Tom Caruso', 'quote_followup')
        return
      }
      // 'Activate job' from chat suggest_job_activation message
      if (action === 'Activate job') {
        setChatActivationModal({
          isOpen: true,
          jobId: '00000000-0000-0000-0000-000000000020',
          quoteId: 'demo-quote-id-toorak',
          jobAddress: '8 Burnside Rd, Toorak',
          quoteTotalCost: 127500,
        })
        return
      }
      // 'Draft email' from suggest_email_draft chat message
      if (action === 'Draft email') {
        void fetchAndInjectEmailDraft(entityId ?? null, null, (entityType as string | undefined) ?? 'general')
        return
      }
      // 'Review quote' — open job snapshot panel to the quote tab
      if (action === 'Review quote' && entityId) {
        onJobMention?.({ id: entityId, address: '', status: 'quoting' })
        return
      }
      // 'Open job' — open job snapshot panel
      if (action === 'Open job' && entityId) {
        onJobMention?.({ id: entityId, address: '', status: 'quoting' })
        return
      }
    },
    [uploadPanel.job, onJobMention]
  )

  // Handler: assumption review complete
  const handleAssumptionComplete = useCallback(
    (_allResolved: boolean) => {
      const quoteId = reviewingAssumptions?.quoteId ?? 'demo-quote-id'
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
            entity_id: quoteId,
            entity_type: 'quote',
          },
        ],
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, assistantMessage])
    },
    [reviewingAssumptions]
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

  // Handler: close QuoteView
  const handleQuoteViewClose = useCallback(() => {
    setViewingQuote(null)
  }, [])

  // Handler: send quote — QuoteView manages the SendQuoteModal flow.
  // This callback fires after the builder has confirmed and the email is sent.
  // We just append a confirmation message; QuoteView stays open (builder can still view).
  const handleQuoteViewSend = useCallback((_quoteId: string) => {
    // Do not close viewingQuote here — let the builder close it themselves
    const assistantMessage: Message = {
      id: generateId(),
      role: 'assistant',
      content: "Quote sent to client. WorkA has logged the email to the job's communication history. You'll be notified when they respond.",
      timestamp: new Date(),
    }
    setMessages((prev) => [...prev, assistantMessage])
  }, [])

  // Handler: revise quote — POST to create v2, close QuoteView, append message
  const handleQuoteViewRevise = useCallback(async (quoteId: string) => {
    setViewingQuote(null)
    try {
      const res = await fetch(`/api/quotes/${quoteId}/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builder_id: builderId }),
      })
      const data = await res.json() as { new_quote_id: string; version: number }
      const assistantMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: `Quote v${data.version} created. All assumptions carry forward — resolve any new items before sending.`,
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, assistantMessage])
    } catch {
      const assistantMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: 'Quote revision created. Resolve any new items before sending.',
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, assistantMessage])
    }
  }, [])

  // Handler: export PDF — open in new tab, close QuoteView
  const handleQuoteViewExportPdf = useCallback((quoteId: string) => {
    window.open(`/api/quotes/${quoteId}/export-pdf`, '_blank')
    setViewingQuote(null)
    const assistantMessage: Message = {
      id: generateId(),
      role: 'assistant',
      content: 'Quote PDF opened in a new tab. Use Print / Save as PDF to export.',
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
    const apiMessage =
      awaitingAddressForNewJob && !trimmed.toLowerCase().startsWith('new job')
        ? `new job at ${trimmed}`
        : trimmed
    setAwaitingAddressForNewJob(false)

    // If we're awaiting an address for a new job, silently prefix the API payload
    // but NOT when forceCreate is true (that's a button action with a known address already)
    const apiPayload = (awaitingAddressForNewJob && !forceCreate) ? `new job at ${trimmed}` : trimmed
    setAwaitingAddressForNewJob(false)
    setPendingTask(null)

    // Add user message to state — always show what the user typed, never the prefixed version
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
          message: apiPayload,
          builder_id: builderId,
          ...(forceCreate ? { force_create: true } : {}),
        }),
      })

      const data: ChatApiResponse = await res.json()

      // Build assistant message — attach duplicateJob if relevant
      // Check both event (backwards compat) and events[] (multi-action)
      const allEvents = [
        ...(data.events ?? []),
        ...(data.event && !data.events?.some((e) => e.type === data.event?.type) ? [data.event] : []),
      ]

      let duplicateJob: DuplicateJob | undefined
      if (
        allEvents.some((e) => e.type === 'show_duplicate_warning') &&
        data.existing_job
      ) {
        duplicateJob = {
          id: data.existing_job.id,
          address: data.existing_job.address,
          status: data.existing_job.status,
        }
      }

      // Attach variation card if present
      let variationCard: VariationCardVariation | undefined
      if (allEvents.some((e) => e.type === 'show_variation') && data.variation) {
        const v = data.variation
        variationCard = {
          id: v.id,
          title: v.title,
          description: v.description,
          amount: v.amount,
          status: v.status,
          job_address: v.job_address,
          created_display: v.created_display,
          job_id: v.job_id,
        }
      }

      const assistantMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: data.message,
        alerts: data.alerts,
        duplicateJob,
        variation: variationCard,
        marginJobs: data.margin_jobs,
        jobList: data.job_list,
        workerList: data.worker_list,
        stateChanges: data.state_changes,
        timestamp: new Date(),
      }

      // Don't add an empty assistant bubble (e.g. pick_job_for_task shows chips only)
      if (data.message?.trim()) {
        setMessages((prev) => [...prev, assistantMessage])
      }
      setLastResponseType(data.intent ?? null)

      // Handle Layer 3 events
      // Dispatch all Layer 3 events — handles both events[] (multi-action) and
      // legacy event field (backwards compat). allEvents is built above.
      for (const evt of allEvents) {
        if (evt.type === 'open_worker_modal' && data.worker && data.invite_url) {
          setWorkerModal({
            isOpen: true,
            worker: data.worker,
            inviteUrl: data.invite_url,
          })
        }

        if (evt.type === 'open_upload_panel' && data.job) {
          setUploadPanel({
            isOpen: true,
            job: data.job,
          })
        }

        if (evt.type === 'open_job_snapshot') {
          const e = evt as OpenJobSnapshotEvent
          onJobMention?.({
            id: e.job_id,
            address: e.job_address,
            status: e.job_status,
            client_name: e.client_name,
          })
        }

        if (evt.type === 'open_email_draft') {
          const e = evt as OpenEmailDraftEvent
          void fetchAndInjectEmailDraft(e.job_id, e.recipient_name, e.intent_hint)
        }

        if (evt.type === 'suggest_email_draft') {
          const e = evt as SuggestEmailDraftEvent
          setMessages((prev) => {
            const updated = [...prev]
            const lastIdx = updated.findLastIndex((m) => m.role === 'assistant')
            if (lastIdx >= 0) {
              updated[lastIdx] = {
                ...updated[lastIdx],
                alerts: [
                  {
                    priority: 'high' as const,
                    message: 'Want me to draft a follow-up email?',
                    action: 'Draft email',
                    entity_id: e.job_id,
                    entity_type: e.intent_hint === 'variation' ? 'variation' as const : e.intent_hint === 'invoice' ? 'invoice' as const : e.intent_hint === 'quote_followup' ? 'quote' as const : 'job' as const,
                  },
                ],
              }
            }
            return updated
          })
        }

        if (evt.type === 'pick_job_for_task') {
          const e = evt as PickJobForTaskEvent
          setPendingTask({
            description: e.task_description,
            jobs: e.jobs ?? [],
          })
        }

        if (evt.type === 'suggest_job_activation') {
          const e = evt as SuggestJobActivationEvent
          setMessages((prev) => {
            const updated = [...prev]
            const lastIdx = updated.findLastIndex((m) => m.role === 'assistant')
            if (lastIdx >= 0) {
              updated[lastIdx] = {
                ...updated[lastIdx],
                alerts: [
                  {
                    priority: 'high' as const,
                    message: 'If Tom has verbally approved, activate the job now to create the milestone timeline and invoice schedule.',
                    action: 'Activate job',
                    entity_id: e.job_id,
                    entity_type: 'job' as const,
                  },
                ],
              }
            }
            return updated
          })
        }

        if (evt.type === 'inbound_email_alert') {
          const e = evt as InboundEmailAlertEvent
          setInboundEmailAlert({
            email: e.email,
            job_address: e.job_address,
            intent: e.intent,
            suggested_action: e.suggested_action,
          })
        }
      }

      // Trigger general query callback — check intent string which may be compound e.g. "morning_brief+job_query"
      if (
        data.intent?.includes('morning_brief') ||
        data.intent?.includes('add_worker') ||
        data.intent === 'unknown'
      ) {
        onGeneralQuery?.()
      }

      // Set address follow-up flag when a create_job came back with no job (address was missing)
      const isNoAddressResponse = !data.job && !data.duplicate &&
        (data.intent === 'new_job' || data.intent === 'create_job' || data.intent?.startsWith('create_job+'))
      if (isNoAddressResponse && data.message?.toLowerCase().includes('address')) {
        setAwaitingAddressForNewJob(true)
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
      inputRef.current?.focus()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingAddressForNewJob, builderId, onJobMention, onGeneralQuery])

  const handleOpenJob = useCallback((jobId: string) => {
    const job = messages.find(m => m.duplicateJob?.id === jobId)?.duplicateJob
    if (job) {
      onJobMention?.({ id: job.id, address: job.address, status: job.status })
    }
  }, [messages, onJobMention])

  const handleOpenJobFromList = useCallback((jobId: string, address: string, status: string, clientName?: string) => {
    onJobMention?.({ id: jobId, address, status, client_name: clientName })
  }, [onJobMention])

  // Handler: approve variation from chat card — POST resolve then open notification modal
  const handleVariationApprove = useCallback(async (variationId: string) => {
    // POST to resolve endpoint
    try {
      await fetch(`/api/variations/${variationId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builder_id: builderId,
          action: 'approved',
        }),
      })
    } catch {
      // Proceed to modal even if resolve call fails (card already updated optimistically)
    }
    setActiveVariationModal({ variationId })
  }, [])

  // Handler: reject variation from chat card — POST resolve, append confirmation
  const handleVariationReject = useCallback(async (variationId: string) => {
    try {
      await fetch(`/api/variations/${variationId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builder_id: builderId,
          action: 'rejected',
        }),
      })
    } catch {
      // Optimistic UI — card already updated
    }
    const confirmMessage: Message = {
      id: generateId(),
      role: 'assistant',
      content: 'Variation rejected. No notification has been sent to the client.',
      timestamp: new Date(),
    }
    setMessages((prev) => [...prev, confirmMessage])
  }, [])

  // Handler: email draft sent — append confirmation message
  const handleEmailDraftSent = useCallback(
    (commId: string, recipientEmail: string, jobAddress: string | null) => {
      const addressDisplay = jobAddress ? ` and logged to the ${jobAddress} communication history` : ' and logged to the job communication history'
      const confirmMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: `Email sent to ${recipientEmail}${addressDisplay}.`,
        timestamp: new Date(),
      }
      void commId
      setMessages((prev) => [...prev, confirmMessage])
    },
    []
  )

  // Handler: variation notification modal sent/skipped
  const handleVariationModalSent = useCallback(() => {
    setActiveVariationModal(null)
    const confirmMessage: Message = {
      id: generateId(),
      role: 'assistant',
      content: 'Variation approved. The client notification has been logged to the job communication history.',
      timestamp: new Date(),
    }
    setMessages((prev) => [...prev, confirmMessage])
  }, [])

  // Handler: job activated from chat modal
  const handleChatActivated = useCallback((result: ActivationResult) => {
    setChatActivationModal(null)
    const depositItem = result.invoice_schedule.find((item) => item.label === 'Deposit')
    const depositAmount = depositItem
      ? new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(depositItem.amount)
      : 'deposit'
    const confirmMessage: Message = {
      id: generateId(),
      role: 'assistant',
      content: `Job activated — ${result.job.address} is now live. Your milestone timeline and invoice schedule are ready. First invoice (${depositAmount} deposit) is scheduled for today.`,
      timestamp: new Date(),
    }
    setMessages((prev) => [...prev, confirmMessage])
    // Refresh the right panel with the now-active job
    onJobMention?.({
      id: result.job.id,
      address: result.job.address,
      status: 'active',
    })
  }, [onJobMention])

  // Handler: open job from margin card — routes to job snapshot panel
  const handleOpenMarginJob = useCallback((jobId: string) => {
    const job = [
      { id: '00000000-0000-0000-0000-000000000010', address: '14 Merri St, Fitzroy', status: 'active', client_name: 'Henderson' },
      { id: '00000000-0000-0000-0000-000000000020', address: '8 Burnside Rd, Toorak', status: 'quoted', client_name: 'Tom Caruso' },
      { id: '00000000-0000-0000-0000-000000000030', address: '52 Bendigo St, Brunswick', status: 'quoting', client_name: 'Brunswick client' },
    ].find((j) => j.id === jobId)
    if (job) {
      onJobMention?.({ id: job.id, address: job.address, status: job.status, client_name: job.client_name })
    }
  }, [onJobMention])

  // Handler: assign task from worker card — pre-fills input with job context if panel is open
  const handleAssignWorkerTask = useCallback((workerFirstName: string) => {
    const jobSuffix = activeJobAddress ? ` at ${activeJobAddress}` : ''
    setInput(`task for ${workerFirstName}${jobSuffix}: `)
    setTimeout(() => {
      const ta = inputRef.current
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length) }
    }, 50)
  }, [activeJobAddress])

  // Handler: create job anyway (skip duplicate check) — pass address so the API knows what to create
  const handleCreateAnyway = useCallback((address: string) => {
    sendMessage(`new job at ${address}`, true)
  }, [sendMessage])

  // Handler: fetch email draft from API and inject inline as a chat message
  const fetchAndInjectEmailDraft = useCallback(async (
    jobId: string | null,
    recipientName: string | null,
    intentHint: string,
    contextMessage?: string
  ) => {
    const loadingId = generateId()
    setMessages((prev) => [...prev, {
      id: loadingId,
      role: 'assistant' as const,
      content: 'Drafting your email…',
      timestamp: new Date(),
    }])
    try {
      const res = await fetch('/api/email-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builder_id: builderId,
          job_id: jobId,
          recipient_name: recipientName,
          intent_hint: intentHint,
          context: contextMessage,
        }),
      })
      if (!res.ok) throw new Error('draft failed')
      const data = await res.json() as { draft: import('./EmailDraftCard').EmailDraftData }
      setMessages((prev) => prev.map((m) =>
        m.id === loadingId
          ? { ...m, content: "Here's your draft — review and send when ready.", emailDraft: data.draft }
          : m
      ))
    } catch {
      setMessages((prev) => prev.map((m) =>
        m.id === loadingId
          ? { ...m, content: 'Something went wrong generating the draft. Try again.' }
          : m
      ))
    }
  }, [builderId])

  // Fire any pending action that needed sendMessage (e.g. "Review variations" from MorningBriefCard)
  useEffect(() => {
    if (pendingAction) {
      setPendingAction(null)
      sendMessage(pendingAction)
    }
  }, [pendingAction, sendMessage])

  // On mount: for new users (no jobs) inject a welcome message directly without an API call.
  // For existing users, send the morning brief (or an injected autoMessage).
  useEffect(() => {
    if (!hasSentInitial) {
      setHasSentInitial(true)
      if (autoMessage) {
        onAutoMessageConsumed?.()
        sendMessage(autoMessage)
      } else if (isDemo) {
        sendMessage('whats on today')
      } else {
        fetch(`/api/jobs?builder_id=${builderId}`)
          .then(r => r.json())
          .then((data: { jobs?: unknown[] }) => {
            if (!data.jobs || data.jobs.length === 0) {
              const firstName = userName.split(' ')[0]
              setMessages([{
                id: 'welcome-msg',
                role: 'assistant',
                content: `Morning ${firstName}. Let's get WorkA set up — it takes about 5 minutes.\n\nTell me your active jobs. You can list them all at once:\n\n"I've got 3 jobs on: 14 Smith St Fitzroy for the Hendersons, 8 Brown Rd Toorak for Caruso, 22 Jones Ave Collingwood"\n\nOr one at a time: "New job at 14 Smith St Fitzroy for the Hendersons"\n\nOnce your first job is in, upload the plans and I'll start building your quote automatically.\n\nYou can also add your crew: "My crew: Jack (carpenter), Mick (plumber), Sarah (tiler)"`,
                timestamp: new Date(),
              }])
            } else {
              sendMessage('whats on today')
            }
          })
          .catch(() => sendMessage('whats on today'))
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSentInitial, sendMessage])

  // Voice input — toggles speech recognition on/off
  const toggleVoice = useCallback(() => {
    if (isListening) {
      recognitionRef.current?.stop()
      setIsListening(false)
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognitionCtor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
    if (!SpeechRecognitionCtor) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec = new SpeechRecognitionCtor() as any
    rec.continuous = false
    rec.interimResults = false
    rec.lang = 'en-AU'
    rec.onstart = () => setIsListening(true)
    rec.onend = () => {
      setIsListening(false)
      recognitionRef.current = null
    }
    rec.onerror = () => {
      setIsListening(false)
      recognitionRef.current = null
    }
    rec.onresult = (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
      const transcript = Array.from(e.results).map(r => r[0].transcript).join(' ')
      setInput(transcript)
      inputRef.current?.focus()
    }
    recognitionRef.current = rec
    rec.start()
  }, [isListening])

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
    <div className="flex flex-col h-full relative">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-[#2e2e2e] bg-[#1a1a1a] flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-[#ff6b2b] flex items-center justify-center flex-shrink-0">
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
          <span className="text-lg font-bold text-[#e0e0e0] tracking-tight">WorkA</span>
          <span
            className="hidden sm:inline-block text-[10px] font-mono text-[#555555] leading-none mt-0.5"
            title={`v${process.env.NEXT_PUBLIC_APP_VERSION} · ${process.env.NEXT_PUBLIC_COMMIT_SHA}`}
          >
            v{process.env.NEXT_PUBLIC_APP_VERSION}·{process.env.NEXT_PUBLIC_COMMIT_SHA}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/settings/rates"
            className="text-sm font-medium text-[#999999] hover:text-[#e0e0e0] px-2.5 py-1 rounded-[4px] hover:bg-[#2a2a2a] transition-colors"
          >
            Data
          </Link>
          {isDemo && (
            <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded-[3px] text-xs font-semibold bg-[rgba(255,152,0,0.15)] text-[#ff9800] border border-[rgba(255,152,0,0.3)]">
              Demo
            </span>
          )}
          <span className="text-sm text-[#999999] font-medium hidden sm:block">{userName}</span>
          <div className="relative group">
            <button
              type="button"
              className="w-8 h-8 rounded-full bg-[#2a2a2a] border border-[#2e2e2e] flex items-center justify-center flex-shrink-0 hover:border-[#ff6b2b]/40 transition-colors"
              aria-label="Account menu"
            >
              <span className="text-xs font-semibold text-[#ff6b2b]">{userInitials}</span>
            </button>
            {/* Dropdown */}
            <div className="absolute right-0 top-full mt-1 w-44 bg-[#222222] border border-[#2e2e2e] rounded-[6px] py-1 hidden group-focus-within:block z-50">
              <div className="px-3 py-2 border-b border-[#2e2e2e]">
                <p className="text-xs font-semibold text-[#e0e0e0] truncate">{userName}</p>
                {isDemo && <p className="text-xs text-[#ff9800]">Demo mode</p>}
              </div>
              <SignOutButton isDemo={isDemo} />
            </div>
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
            builderId={builderId}
            onOpenJob={handleOpenJob}
            onOpenJobFromList={handleOpenJobFromList}
            onCreateAnyway={handleCreateAnyway}
            onAction={handleAction}
            onVariationApprove={handleVariationApprove}
            onVariationReject={handleVariationReject}
            onOpenMarginJob={handleOpenMarginJob}
            onAssignWorkerTask={handleAssignWorkerTask}
            onEmailSent={handleEmailDraftSent}
            onEmailRevise={() => void fetchAndInjectEmailDraft(null, null, 'general')}
          />
        ))}

        {/* Loading indicator */}
        {loading && (
          <div className="flex justify-start mb-4" role="status" aria-label="WorkA is thinking">
            <div className="bg-[#222222] border border-[#2e2e2e] rounded-[6px] px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-[#555555]">WorkA is thinking</span>
                <span className="flex items-center gap-0.5" aria-hidden="true">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#555555] animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-[#555555] animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-[#555555] animate-bounce [animation-delay:300ms]" />
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
          builderId={builderId}
          onIntakeComplete={handleIntakeComplete}
          preloadedFiles={pendingFilesForUpload ?? undefined}
        />
      )}

      {/* ── Assumption Review ──────────────────────────────────────────────── */}
      {reviewingAssumptions && (
        <AssumptionReview
          quoteId={reviewingAssumptions.quoteId}
          builderId={builderId}
          jobAddress={reviewingAssumptions.jobAddress}
          onComplete={handleAssumptionComplete}
          onDismiss={handleAssumptionDismiss}
          onViewQuote={(quoteId) => setViewingQuote({ quoteId })}
          similarProjects={reviewingAssumptions.similarProjects}
          scopeHints={reviewingAssumptions.scopeHints}
          totalInMemory={reviewingAssumptions.totalInMemory}
        />
      )}

      {/* ── Quote View ─────────────────────────────────────────────────────── */}
      {viewingQuote && (
        <QuoteView
          quoteId={viewingQuote.quoteId}
          builderId={builderId}
          onClose={handleQuoteViewClose}
          onSend={handleQuoteViewSend}
          onRevise={handleQuoteViewRevise}
          onExportPdf={handleQuoteViewExportPdf}
        />
      )}

      {/* ── Variation Notification Modal ────────────────────────────────────── */}
      {activeVariationModal && (
        <VariationNotificationModal
          variationId={activeVariationModal.variationId}
          builderId={builderId}
          isOpen={!!activeVariationModal}
          onClose={() => setActiveVariationModal(null)}
          onSent={handleVariationModalSent}
        />
      )}

      {/* ── Email Draft Modal ───────────────────────────────────────────────── */}
      {emailDraftModal && (
        <EmailDraftModal
          isOpen={emailDraftModal.isOpen}
          onClose={() => setEmailDraftModal(null)}
          onSent={handleEmailDraftSent}
          builderId={builderId}
          jobId={emailDraftModal.jobId}
          recipientName={emailDraftModal.recipientName}
          intentHint={emailDraftModal.intentHint}
        />
      )}

      {/* ── Chat Activation Modal ──────────────────────────────────────────── */}
      {chatActivationModal && (
        <ActivationModal
          isOpen={chatActivationModal.isOpen}
          onClose={() => setChatActivationModal(null)}
          onActivated={handleChatActivated}
          job={{ id: chatActivationModal.jobId, address: chatActivationModal.jobAddress }}
          quote={{ id: chatActivationModal.quoteId, total_cost: chatActivationModal.quoteTotalCost, version: 1 }}
          builderId={builderId}
        />
      )}

      {/* ── Inbound Email Alert ─────────────────────────────────────────────── */}
      {inboundEmailAlert && (
        <div className="absolute bottom-24 left-4 right-4 z-20 max-w-lg">
          <InboundEmailAlert
            email={inboundEmailAlert.email}
            job_address={inboundEmailAlert.job_address}
            intent={inboundEmailAlert.intent}
            suggested_action={inboundEmailAlert.suggested_action}
            onReply={() => {
              const draft = inboundEmailAlert.suggested_action?.draft
              setEmailDraftModal({
                isOpen: true,
                jobId: null,
                recipientName: inboundEmailAlert.email.from,
                intentHint: 'general',
                ...(draft ? {} : {}),
              })
              setInboundEmailAlert(null)
            }}
            onDismiss={() => setInboundEmailAlert(null)}
          />
        </div>
      )}

      {/* ── Input ──────────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-t border-[#2e2e2e] bg-[#1a1a1a] px-4 pt-2 pb-3 pb-safe">
        {/* Dropped file bar — shown when files have been drag-dropped */}
        {pendingDropFiles.length > 0 && (
          <DroppedFileBar
            files={pendingDropFiles}
            jobs={dropJobs}
            jobQuery={dropJobQuery}
            onJobQueryChange={setDropJobQuery}
            onSelectJob={(job) => {
              const planFiles = pendingDropFiles.filter(f => f.type === 'plan' || f.type === 'unknown')
              const otherFiles = pendingDropFiles.filter(f => f.type !== 'plan' && f.type !== 'unknown')

              if (planFiles.length > 0) {
                setPendingDropFiles([])
                setDropJobQuery('')
                onJobMention?.({ id: job.id, address: job.address, status: job.status })
                // Queue plan files into the upload panel via pendingFilesForUpload
                setPendingFilesForUpload(planFiles.map(f => f.file))
                setUploadPanel({ isOpen: true, job: { id: job.id, address: job.address, status: job.status } })
              }

              if (otherFiles.length > 0) {
                const desc = otherFiles.map(f => `${f.label}: ${f.file.name}`).join(', ')
                sendMessage(`Uploading to ${job.address}: ${desc}`)
                setPendingDropFiles([])
                setDropJobQuery('')
              }
            }}
            onDismiss={() => { setPendingDropFiles([]); setDropJobQuery('') }}
          />
        )}
        {/* Job picker — shown when a task needs a job assigned */}
        {pendingTask ? (
          <div className="mb-2">
            <p className="text-[11px] text-[#555555] mb-1.5">
              Adding: <span className="font-medium text-[#e0e0e0]">&ldquo;{pendingTask.description}&rdquo;</span> — pick a job:
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
              {pendingTask.jobs.map((job) => {
                const shortAddr = job.address.split(',')[0]
                return (
                  <button
                    key={job.id}
                    type="button"
                    disabled={loading}
                    onClick={async () => {
                      const desc = pendingTask.description
                      setPendingTask(null)
                      // Optimistically add a user-side confirmation message
                      const confirmMsg: Message = {
                        id: generateId(),
                        role: 'assistant',
                        content: `Task added: "${desc}" — ${shortAddr}.`,
                        timestamp: new Date(),
                      }
                      // Create the task directly
                      try {
                        await fetch(`/api/jobs/${job.id}/tasks`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ description: desc, builder_id: builderId, assigned_to: null }),
                        })
                      } catch { /* best-effort */ }
                      setMessages((prev) => [...prev, confirmMsg])
                    }}
                    className="flex-shrink-0 px-3 py-1.5 text-[12px] font-medium rounded-[4px] bg-[#2a2a2a] border border-[#2e2e2e] text-[#e0e0e0] hover:border-[#ff6b2b]/40 transition-colors disabled:opacity-40 whitespace-nowrap"
                  >
                    {shortAddr}
                  </button>
                )
              })}
              <button
                type="button"
                onClick={() => setPendingTask(null)}
                className="flex-shrink-0 px-3 py-1.5 text-[12px] font-medium rounded-[4px] bg-[#2a2a2a] border border-[#2e2e2e] text-[#555555] hover:text-[#999999] transition-colors whitespace-nowrap"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
        /* Contextual quick actions — max 3, first chip is primary (orange) */
        (() => {
          type Chip = { label: string; msg?: string; fill?: string }
          let chips: Chip[]
          if (lastResponseType?.includes('morning_brief')) {
            chips = [
              { label: 'Show variations', msg: 'show my variations' },
              { label: 'My jobs', msg: 'show my jobs' },
              { label: 'Add task', fill: 'task for ' },
            ]
          } else if (lastResponseType?.includes('show_variation') || lastResponseType?.includes('variation')) {
            chips = [
              { label: 'Draft follow-up', msg: 'draft a follow-up to the client' },
              { label: 'My jobs', msg: 'show my jobs' },
              { label: "What's on", msg: 'whats on today' },
            ]
          } else if (lastResponseType?.includes('job_list') || lastResponseType?.includes('show_jobs') || lastResponseType?.includes('margin')) {
            chips = [
              { label: 'New job', fill: 'New job at ' },
              { label: 'Show variations', msg: 'show my variations' },
              { label: "What's on", msg: 'whats on today' },
            ]
          } else if (lastResponseType?.includes('email') || lastResponseType?.includes('comms')) {
            chips = [
              { label: "What's on", msg: 'whats on today' },
              { label: 'My jobs', msg: 'show my jobs' },
              { label: 'Add task', fill: 'task for ' },
            ]
          } else {
            chips = [
              { label: "What's on", msg: 'whats on today' },
              { label: 'New job', fill: 'New job at ' },
              { label: 'My team', msg: 'show my team' },
            ]
          }
          return (
            <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none" aria-label="Quick actions">
              {chips.map(({ label, msg, fill }, idx) => (
                <button
                  key={label}
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    if (fill) { setInput(fill); inputRef.current?.focus() }
                    else if (msg) sendMessage(msg)
                  }}
                  className={`flex-shrink-0 px-3 py-1.5 text-[12px] font-medium rounded-[4px] transition-colors disabled:opacity-40 whitespace-nowrap ${
                    idx === 0
                      ? 'bg-[rgba(255,107,43,0.15)] border border-[rgba(255,107,43,0.3)] text-[#ff6b2b] hover:bg-[rgba(255,107,43,0.25)]'
                      : 'bg-[#2a2a2a] border border-[#2e2e2e] text-[#999999] hover:border-[#ff6b2b]/30 hover:text-[#e0e0e0]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )
        })()
        )}

        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <label htmlFor="chat-input" className="sr-only">
            Type a message
          </label>
          {/* Mic button */}
          <button
            type="button"
            onClick={toggleVoice}
            disabled={loading}
            aria-label={isListening ? 'Stop recording' : 'Start voice input'}
            className={`flex-shrink-0 w-10 h-10 rounded-[6px] flex items-center justify-center transition-colors disabled:opacity-40 ${
              isListening
                ? 'bg-[rgba(244,67,54,0.15)] text-[#f44336] animate-pulse'
                : 'bg-[#2a2a2a] text-[#555555] hover:text-[#999999] border border-[#2e2e2e]'
            }`}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
            </svg>
          </button>
          <textarea
            ref={inputRef}
            id="chat-input"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={isListening ? 'Listening…' : 'Ask something or tap a button above'}
            rows={1}
            disabled={loading}
            className="flex-1 resize-none bg-[#2a2a2a] border border-[#2e2e2e] rounded-[6px] px-3 py-2 text-[13px] text-[#e0e0e0] placeholder:text-[#333333] focus:outline-none focus:border-[#ff6b2b]/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed leading-relaxed overflow-hidden"
            style={{ minHeight: '40px', maxHeight: '120px' }}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="flex-shrink-0 bg-[#ff6b2b] text-white text-[12px] font-semibold px-3 py-1.5 rounded-[4px] min-h-[40px] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[#e55a1f] transition-colors"
            aria-label="Send message"
          >
            Send
          </button>
        </form>
        <p className="mt-1.5 text-xs text-[#555555] hidden sm:block">
          Press <kbd className="font-mono text-xs bg-[#2a2a2a] border border-[#2e2e2e] rounded px-1">Enter</kbd> to send
          &nbsp;&middot;&nbsp;
          <kbd className="font-mono text-xs bg-[#2a2a2a] border border-[#2e2e2e] rounded px-1">Shift+Enter</kbd> for new line
        </p>
      </div>
    </div>
  )
}
