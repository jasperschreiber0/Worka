'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
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
  state_changes?: import('@/app/api/chat/route').StateChange[]
  event?: WorkerModalEvent | UploadPanelEvent | DuplicateWarningEvent | OpenJobSnapshotEvent | ShowVariationEvent | OpenEmailDraftEvent | SuggestEmailDraftEvent | InboundEmailAlertEvent | SuggestJobActivationEvent | { type: string; [key: string]: unknown }
  events?: Array<WorkerModalEvent | UploadPanelEvent | DuplicateWarningEvent | OpenJobSnapshotEvent | ShowVariationEvent | OpenEmailDraftEvent | SuggestEmailDraftEvent | InboundEmailAlertEvent | SuggestJobActivationEvent | { type: string; [key: string]: unknown }>
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
      className="w-full px-3 py-2 text-sm text-left text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors flex items-center gap-2"
    >
      <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15M12 9l-3 3m0 0 3 3m-3-3h12.75" />
      </svg>
      Sign out
    </button>
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
}: ChatInterfaceProps = {}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasSentInitial, setHasSentInitial] = useState(false)
  const [awaitingAddressForNewJob, setAwaitingAddressForNewJob] = useState(false)
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
  // open EmailDraftModal immediately and notify the parent that we consumed it.
  useEffect(() => {
    if (pendingEmailDraft) {
      setEmailDraftModal({
        isOpen: true,
        jobId: pendingEmailDraft.jobId,
        recipientName: pendingEmailDraft.recipientName,
        intentHint: pendingEmailDraft.intentHint,
      })
      onPendingEmailDraftConsumed?.()
    }
  // We only want to react when pendingEmailDraft changes (not on every render)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEmailDraft])

  // Open UploadPanel when a job's Files tab triggers "Upload plans"
  useEffect(() => {
    if (pendingUpload) {
      setUploadPanel({
        isOpen: true,
        job: {
          id: pendingUpload.id,
          builder_id: builderId,
          address: pendingUpload.address,
          client_id: null,
          status: pendingUpload.status as import('@/lib/types/database.types').JobStatus,
          job_type: null,
          notes: null,
          budget_estimate: null,
          scope_notes: null,
          quote_deadline: null,
          client_deadline: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      })
      onPendingUploadConsumed?.()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingUpload])

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

  // Pending action that requires sendMessage (defined later)
  const [pendingAction, setPendingAction] = useState<string | null>(null)

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
      // 'Chase payment' from morning brief (overdue invoice on Fitzroy job)
      if (action === 'Chase payment') {
        setEmailDraftModal({
          isOpen: true,
          jobId: '00000000-0000-0000-0000-000000000010',
          recipientName: 'the Hendersons',
          intentHint: 'invoice',
        })
        return
      }
      // 'Follow up' from morning brief (Toorak quote stale)
      if (action === 'Follow up') {
        setEmailDraftModal({
          isOpen: true,
          jobId: '00000000-0000-0000-0000-000000000020',
          recipientName: 'Tom Caruso',
          intentHint: 'quote_followup',
        })
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
        // entityId is the job_id passed through the alert
        setEmailDraftModal({
          isOpen: true,
          jobId: entityId ?? null,
          intentHint: (entityType as EmailIntentHint | undefined) ?? 'general',
        })
        return
      }
    },
    [uploadPanel.job]
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

    // If we're awaiting an address for a new job, silently prefix the API payload
    // but NOT when forceCreate is true (that's a button action with a known address already)
    const apiPayload = (awaitingAddressForNewJob && !forceCreate) ? `new job at ${trimmed}` : trimmed
    setAwaitingAddressForNewJob(false)

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
        stateChanges: data.state_changes,
        timestamp: new Date(),
      }

      setMessages((prev) => [...prev, assistantMessage])

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
          setEmailDraftModal({
            isOpen: true,
            jobId: e.job_id,
            recipientName: e.recipient_name ?? undefined,
            intentHint: e.intent_hint as EmailIntentHint,
          })
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

  // Handler: email draft sent — close modal, append confirmation message
  const handleEmailDraftSent = useCallback(
    (commId: string, recipientEmail: string, jobAddress: string | null) => {
      setEmailDraftModal(null)
      const addressDisplay = jobAddress ? ` and logged to the ${jobAddress} communication history` : ' and logged to the job communication history'
      const confirmMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: `Email sent to ${recipientEmail}${addressDisplay}.`,
        timestamp: new Date(),
      }
      void commId // commId logged server-side; available here for future use
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

  // Handler: create job anyway (skip duplicate check)
  const handleCreateAnyway = useCallback(() => {
    sendMessage('create job anyway', true)
  }, [sendMessage])

  // Fire any pending action that needed sendMessage (e.g. "Review variations" from MorningBriefCard)
  useEffect(() => {
    if (pendingAction) {
      setPendingAction(null)
      sendMessage(pendingAction)
    }
  }, [pendingAction, sendMessage])

  // On mount: auto-send either the injected autoMessage (from homepage ?action=/?job= params)
  // or the default morning brief if no override is provided.
  useEffect(() => {
    if (!hasSentInitial) {
      setHasSentInitial(true)
      if (autoMessage) {
        onAutoMessageConsumed?.()
        sendMessage(autoMessage)
      } else {
        sendMessage('whats on today')
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div className="flex flex-col h-full relative">
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
          {isDemo && (
            <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-700 border border-amber-200">
              Demo
            </span>
          )}
          <span className="text-sm text-slate-600 font-medium hidden sm:block">{userName}</span>
          <div className="relative group">
            <button
              type="button"
              className="w-8 h-8 rounded-full bg-brand-100 border border-brand-200 flex items-center justify-center flex-shrink-0 hover:bg-brand-200 transition-colors"
              aria-label="Account menu"
            >
              <span className="text-xs font-semibold text-brand-700">{userInitials}</span>
            </button>
            {/* Dropdown */}
            <div className="absolute right-0 top-full mt-1 w-44 bg-white border border-slate-200 rounded-xl shadow-lg py-1 hidden group-focus-within:block z-50">
              <div className="px-3 py-2 border-b border-slate-100">
                <p className="text-xs font-semibold text-slate-900 truncate">{userName}</p>
                {isDemo && <p className="text-xs text-amber-600">Demo mode</p>}
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
            onOpenJob={handleOpenJob}
            onOpenJobFromList={handleOpenJobFromList}
            onCreateAnyway={handleCreateAnyway}
            onAction={handleAction}
            onVariationApprove={handleVariationApprove}
            onVariationReject={handleVariationReject}
            onOpenMarginJob={handleOpenMarginJob}
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
          builderId={builderId}
          onIntakeComplete={handleIntakeComplete}
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
            className="flex-shrink-0 btn-primary px-4 min-h-[44px] text-sm disabled:opacity-50 disabled:cursor-not-allowed"
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
