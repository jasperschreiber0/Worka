'use client'

import { useState, useCallback } from 'react'
import ChatInterface from '@/components/chat/ChatInterface'
import JobSnapshotPanel from '@/components/job/JobSnapshotPanel'
import MobileJobSheet from '@/components/job/MobileJobSheet'
import type { ActiveJob } from '@/components/job/JobSnapshotPanel'

// ─── Component ────────────────────────────────────────────────────────────────

export default function ChatShell() {
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null)
  const [panelVisible, setPanelVisible] = useState(false)
  const [pendingQuoteView, setPendingQuoteView] = useState<string | null>(null)

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

  return (
    <div className="h-screen flex overflow-hidden bg-white">
      {/* ── Left: chat — full width on mobile, flex-1 on desktop ──────────── */}
      <div className="flex-1 min-w-0 flex flex-col h-full">
        <ChatInterface
          onJobMention={handleJobMention}
          onGeneralQuery={handleGeneralQuery}
          initialQuoteId={pendingQuoteView}
          onInitialQuoteConsumed={handleQuoteViewConsumed}
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
