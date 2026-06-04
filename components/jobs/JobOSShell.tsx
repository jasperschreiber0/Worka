'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import StatePanel from './StatePanel'
import JobSnapshotPanel, { type ActiveJob } from '@/components/job/JobSnapshotPanel'
import ChatInterface, { type PendingEmailDraft } from '@/components/chat/ChatInterface'
import type { JobSnapshot } from '@/lib/job-snapshot-demo'

// ─── Props ────────────────────────────────────────────────────────────────────

interface JobOSShellProps {
  jobId: string
  builderId: string
  userName: string
  userInitials: string
  isDemo: boolean
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function JobOSShell({
  jobId,
  builderId,
  userName,
  userInitials,
  isDemo,
}: JobOSShellProps) {
  const router = useRouter()
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null)
  const [chatVisible, setChatVisible] = useState(true)
  const [pendingEmailDraft, setPendingEmailDraft] = useState<PendingEmailDraft | null>(null)
  const [pendingUpload, setPendingUpload] = useState<ActiveJob | null>(null)
  const [pendingQuoteView, setPendingQuoteView] = useState<string | null>(null)

  // Fetch snapshot for StatePanel (JobSnapshotPanel also fetches internally)
  useEffect(() => {
    fetch(`/api/jobs/${jobId}/snapshot`)
      .then((r) => r.json())
      .then((data: { snapshot: JobSnapshot }) => setSnapshot(data.snapshot))
      .catch(() => {})
  }, [jobId])

  const job: ActiveJob = {
    id: jobId,
    address: snapshot?.job.address ?? '',
    status: snapshot?.job.status ?? 'quoting',
    client_name: snapshot?.job.client_name ?? undefined,
  }

  const handleViewQuote = useCallback((quoteId: string) => {
    setPendingQuoteView(quoteId)
  }, [])

  const handleComposeEmail = useCallback((jId: string) => {
    setPendingEmailDraft({ jobId: jId, intentHint: 'general' })
  }, [])

  const handleUploadPlans = useCallback((j: ActiveJob) => {
    setPendingUpload(j)
  }, [])

  const handleAddInvoice = useCallback((jId: string) => {
    setPendingEmailDraft({ jobId: jId, intentHint: 'invoice' })
  }, [])

  const handleAddTask = useCallback((jobAddress: string) => {
    // On job OS, tasks are managed within the Tasks tab; this is a no-op callback for compat
    void jobAddress
  }, [])

  const handleJobActivated = useCallback(() => {
    // Refresh snapshot after activation
    fetch(`/api/jobs/${jobId}/snapshot`)
      .then((r) => r.json())
      .then((data: { snapshot: JobSnapshot }) => setSnapshot(data.snapshot))
      .catch(() => {})
  }, [jobId])

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-slate-50">
      {/* ── Desktop 3-panel layout ────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* LEFT: State machine — desktop only */}
        <div className="hidden lg:flex lg:w-52 xl:w-56 flex-shrink-0">
          <StatePanel
            jobAddress={job.address}
            jobStatus={job.status}
            jobRef={snapshot?.job.job_ref}
            quoteDeadline={snapshot?.job.quote_deadline}
            clientDeadline={snapshot?.job.client_deadline}
          />
        </div>

        {/* CENTER: Job snapshot tabs */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {/* Mobile: back nav */}
          <div className="lg:hidden flex items-center gap-2 px-3 py-2 bg-white border-b border-slate-200">
            <button
              type="button"
              onClick={() => router.push('/jobs')}
              className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
              </svg>
              Jobs
            </button>
            {snapshot?.job.address && (
              <p className="text-sm font-medium text-slate-900 truncate">{snapshot.job.address}</p>
            )}
          </div>

          <JobSnapshotPanel
            job={job.address ? job : null}
            onClose={() => router.push('/jobs')}
            builderId={builderId}
            standalone
            onViewQuote={handleViewQuote}
            onComposeEmail={handleComposeEmail}
            onUploadPlans={handleUploadPlans}
            onAddInvoice={handleAddInvoice}
            onJobActivated={handleJobActivated}
            onAddTask={handleAddTask}
          />
        </div>

        {/* RIGHT: Chat panel — desktop only, collapsible */}
        {chatVisible && (
          <div className="hidden lg:flex lg:w-80 xl:w-96 flex-shrink-0 flex-col border-l border-slate-200 bg-white">
            <ChatInterface
              builderId={builderId}
              userName={userName}
              userInitials={userInitials}
              isDemo={isDemo}
              showHeader={false}
              noAutoMessage
              activeJobAddress={job.address || null}
              pendingEmailDraft={pendingEmailDraft}
              onPendingEmailDraftConsumed={() => setPendingEmailDraft(null)}
              pendingUpload={pendingUpload}
              onPendingUploadConsumed={() => setPendingUpload(null)}
              initialQuoteId={pendingQuoteView}
              onInitialQuoteConsumed={() => setPendingQuoteView(null)}
            />
          </div>
        )}

        {/* Chat toggle button — desktop only */}
        <button
          type="button"
          onClick={() => setChatVisible((v) => !v)}
          className="hidden lg:flex fixed bottom-6 right-4 z-30 items-center gap-1.5 px-3 py-2 rounded-full bg-brand-500 text-white text-xs font-semibold shadow-lg hover:bg-brand-600 transition-colors"
          aria-label={chatVisible ? 'Hide chat' : 'Ask WorkA'}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
          </svg>
          {chatVisible ? 'Hide chat' : 'Ask WorkA'}
        </button>
      </div>
    </div>
  )
}
