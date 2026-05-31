'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import ChatInterface, { type PendingEmailDraft } from '@/components/chat/ChatInterface'
import JobSnapshotPanel from '@/components/job/JobSnapshotPanel'
import MobileJobSheet from '@/components/job/MobileJobSheet'
import type { ActiveJob } from '@/components/job/JobSnapshotPanel'

// ─── Action → message map ─────────────────────────────────────────────────────

const ACTION_MESSAGES: Record<string, string> = {
  new_quote: 'new job',
  sample_quote: 'new job at 52 Bendigo St',
}

// ─── Job ID → chat trigger message ───────────────────────────────────────────

const JOB_MESSAGES: Record<string, string> = {
  '00000000-0000-0000-0000-000000000011': 'toorak job',
  '00000000-0000-0000-0000-000000000020': 'toorak job',
  '00000000-0000-0000-0000-000000000010': 'fitzroy job',
  '00000000-0000-0000-0000-000000000012': 'brunswick job',
  '00000000-0000-0000-0000-000000000030': 'brunswick job',
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface ChatShellProps {
  builderId: string
  userName: string
  userInitials: string
  isDemo: boolean
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ChatShell({ builderId, userName, userInitials, isDemo }: ChatShellProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null)
  const [panelVisible, setPanelVisible] = useState(false)
  const [pendingQuoteView, setPendingQuoteView] = useState<string | null>(null)
  const [pendingEmailDraft, setPendingEmailDraft] = useState<PendingEmailDraft | null>(null)
  const [pendingUpload, setPendingUpload] = useState<ActiveJob | null>(null)

  const [autoMessage, setAutoMessage] = useState<string | null>(null)
  const [pendingFillInput, setPendingFillInput] = useState<string | null>(null)
  const consumedRef = useRef(false)

  useEffect(() => {
    if (consumedRef.current) return
    const action = searchParams.get('action')
    const jobId = searchParams.get('job')

    if (action && ACTION_MESSAGES[action]) {
      consumedRef.current = true
      const message = ACTION_MESSAGES[action]
      const t = setTimeout(() => {
        setAutoMessage(message)
        router.replace('/chat')
      }, 500)
      return () => clearTimeout(t)
    }

    if (jobId && JOB_MESSAGES[jobId]) {
      consumedRef.current = true
      const message = JOB_MESSAGES[jobId]
      const t = setTimeout(() => {
        setAutoMessage(message)
        router.replace('/chat')
      }, 500)
      return () => clearTimeout(t)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleAutoMessageConsumed = useCallback(() => {
    setAutoMessage(null)
  }, [])

  const handleJobMention = useCallback((job: ActiveJob) => {
    setActiveJob(job)
    setPanelVisible(true)
  }, [])

  const handleGeneralQuery = useCallback(() => {
    setPanelVisible(false)
  }, [])

  const handlePanelClose = useCallback(() => {
    setPanelVisible(false)
  }, [])

  const handleViewQuote = useCallback((quoteId: string) => {
    setPendingQuoteView(quoteId)
  }, [])

  const handleQuoteViewConsumed = useCallback(() => {
    setPendingQuoteView(null)
  }, [])

  const handleComposeEmail = useCallback((jobId: string) => {
    setPendingEmailDraft({ jobId, intentHint: 'general' })
  }, [])

  const handleEmailDraftConsumed = useCallback(() => {
    setPendingEmailDraft(null)
  }, [])

  const handleUploadPlans = useCallback((job: ActiveJob) => {
    setPendingUpload(job)
  }, [])

  const handleUploadConsumed = useCallback(() => {
    setPendingUpload(null)
  }, [])

  const handleAddInvoice = useCallback((jobId: string) => {
    setPendingEmailDraft({ jobId, intentHint: 'invoice' })
  }, [])

  const handleAddTask = useCallback((jobAddress: string) => {
    setPendingFillInput(`add task at ${jobAddress}: `)
  }, [])

  return (
    <div className="h-screen flex overflow-hidden bg-white">
      {/* ── Left: chat ────────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col h-full">
        <ChatInterface
          builderId={builderId}
          userName={userName}
          userInitials={userInitials}
          isDemo={isDemo}
          onJobMention={handleJobMention}
          onGeneralQuery={handleGeneralQuery}
          initialQuoteId={pendingQuoteView}
          onInitialQuoteConsumed={handleQuoteViewConsumed}
          pendingEmailDraft={pendingEmailDraft}
          onPendingEmailDraftConsumed={handleEmailDraftConsumed}
          pendingUpload={pendingUpload}
          onPendingUploadConsumed={handleUploadConsumed}
          autoMessage={autoMessage}
          onAutoMessageConsumed={handleAutoMessageConsumed}
          pendingFillInput={pendingFillInput}
          onFillInputConsumed={() => setPendingFillInput(null)}
        />
      </div>

      {/* ── Right: job snapshot panel — desktop only ──────────────────────── */}
      <div
        className={`
          hidden md:flex md:flex-col
          w-[420px] border-l border-slate-200 bg-slate-50
          transition-all duration-300 ease-in-out
          ${panelVisible ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0 pointer-events-none'}
        `}
      >
        <JobSnapshotPanel
          job={activeJob}
          onClose={handlePanelClose}
          onViewQuote={handleViewQuote}
          onComposeEmail={handleComposeEmail}
          onUploadPlans={handleUploadPlans}
          onAddInvoice={handleAddInvoice}
          onAddTask={handleAddTask}
          builderId={builderId}
        />
      </div>

      {/* ── Mobile bottom sheet (hidden on md+ where side panel shows) ─────── */}
      <div className="md:hidden">
        {panelVisible && activeJob && (
          <MobileJobSheet
            job={activeJob}
            onClose={handlePanelClose}
            onViewQuote={handleViewQuote}
            onAddTask={handleAddTask}
          />
        )}
      </div>
    </div>
  )
}
