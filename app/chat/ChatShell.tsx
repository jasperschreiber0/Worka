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

// ─── Component ────────────────────────────────────────────────────────────────

export default function ChatShell() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null)
  const [panelVisible, setPanelVisible] = useState(false)
  const [pendingQuoteView, setPendingQuoteView] = useState<string | null>(null)
  const [pendingEmailDraft, setPendingEmailDraft] = useState<PendingEmailDraft | null>(null)

  // Auto-message from ?action= or ?job= query param
  const [autoMessage, setAutoMessage] = useState<string | null>(null)
  const consumedRef = useRef(false)

  useEffect(() => {
    if (consumedRef.current) return
    const action = searchParams.get('action')
    const jobId = searchParams.get('job')

    if (action && ACTION_MESSAGES[action]) {
      consumedRef.current = true
      const message = ACTION_MESSAGES[action]
      // Slight delay so the chat UI is fully mounted before the message fires
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
    // Keep activeJob so the panel can animate out gracefully
  }, [])

  const handlePanelClose = useCallback(() => {
    setPanelVisible(false)
  }, [])

  // Called by QuoteTab's "View quote" button inside the snapshot panel.
  // We store the quoteId and pass it down to ChatInterface so it opens QuoteView.
  const handleViewQuote = useCallback((quoteId: string) => {
    setPendingQuoteView(quoteId)
  }, [])

  // Called by ChatInterface after it has consumed the pending quote ID.
  const handleQuoteViewConsumed = useCallback(() => {
    setPendingQuoteView(null)
  }, [])

  // Called by CommsTab's "Compose email" button inside the snapshot panel.
  // We store the draft params and pass them down to ChatInterface so it opens EmailDraftModal.
  const handleComposeEmail = useCallback((jobId: string) => {
    setPendingEmailDraft({
      jobId,
      intentHint: 'general',
    })
  }, [])

  // Called by ChatInterface after it has consumed the pending email draft.
  const handleEmailDraftConsumed = useCallback(() => {
    setPendingEmailDraft(null)
  }, [])

  return (
    <div className="h-screen flex overflow-hidden bg-white">
      {/* ── Left: chat — full width on mobile, flex-1 on desktop ──────────── */}
      <div className="flex-1 min-w-0 flex flex-col h-full">
        <ChatInterface
          onJobMention={handleJobMention}
          onGeneralQuery={handleGeneralQuery}
          initialQuoteId={pendingQuoteView}
          onInitialQuoteConsumed={handleQuoteViewConsumed}
          pendingEmailDraft={pendingEmailDraft}
          onPendingEmailDraftConsumed={handleEmailDraftConsumed}
          autoMessage={autoMessage}
          onAutoMessageConsumed={handleAutoMessageConsumed}
        />
      </div>

      {/* ── Right: job snapshot panel — desktop only ──────────────────────── */}
      {/* Hidden on mobile (shown as bottom sheet instead) */}
      {/* Slides in from right using CSS transform, never display:none */}
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
        />
      </div>

      {/* ── Mobile bottom sheet ────────────────────────────────────────────── */}
      {panelVisible && activeJob && (
        <MobileJobSheet
          job={activeJob}
          onClose={handlePanelClose}
          onViewQuote={handleViewQuote}
        />
      )}
    </div>
  )
}
