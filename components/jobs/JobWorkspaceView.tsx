'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import JobSnapshotPanel, { type ActiveJob } from '@/components/job/JobSnapshotPanel'
import UploadPanel, { type UploadPanelJob } from '@/components/chat/UploadPanel'
import QuoteView from '@/components/quote/QuoteView'
import AddVariationDrawer from '@/components/variations/AddVariationDrawer'
import CloseOutJobDrawer, { type CloseOutResult } from '@/components/jobs/CloseOutJobDrawer'

function formatAud(amount: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(amount)
}

// FIX 5 (demo honesty) + FIX 6 (trust): builds the close-out toast copy from
// what actually happened server-side, rather than a single fixed message —
// demo mode never persists a real learning update, an already-completed job
// makes no changes at all, and a genuine update should say what changed
// (only when the variance was large enough to be worth saying, see
// MEANINGFUL_VARIANCE_PCT server-side).
function closeOutMessage(result: CloseOutResult): string {
  if (result.demo) {
    return 'Demo mode preview — learning is simulated. Nothing is saved in demo mode.'
  }
  if (result.already_reconciled) {
    return 'This job was already closed out — no changes made.'
  }
  const update = result.knowledge_updates[0]
  if (update) {
    return `WorkA updated its ${update.trade_name.toLowerCase()} knowledge: previous estimate ${formatAud(update.previous_rate)}/${update.unit} → actual job cost ${formatAud(update.new_rate)}/${update.unit}. Future ${update.trade_name.toLowerCase()} estimates will improve.`
  }
  return 'Job closed out — thanks for the update.'
}

interface JobWorkspaceViewProps {
  jobId: string
  builderId: string
}

interface Toast {
  tone: 'info' | 'error'
  message: string
}

export default function JobWorkspaceView({ jobId, builderId }: JobWorkspaceViewProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [job, setJob] = useState<ActiveJob | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [viewingQuoteId, setViewingQuoteId] = useState<string | null>(null)
  const [variationDrawerOpen, setVariationDrawerOpen] = useState(false)
  const [closeOutOpen, setCloseOutOpen] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/jobs/${jobId}`)
      .then((res) => {
        if (!res.ok) throw new Error()
        return res.json()
      })
      .then((data) => {
        if (!cancelled) {
          setJob(data.job)
          // New Job -> straight into upload, no extra click required.
          if (searchParams.get('upload') === '1') {
            setUploadOpen(true)
            router.replace(`/jobs/${jobId}`)
          }
        }
      })
      .catch(() => {
        if (!cancelled) setNotFound(true)
      })
    return () => { cancelled = true }
  }, [jobId])

  const refetchJob = useCallback(() => {
    fetch(`/api/jobs/${jobId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data?.job) setJob(data.job) })
      .catch(() => {})
  }, [jobId])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  const handleUploadPlans = useCallback(() => setUploadOpen(true), [])

  const handleIntakeComplete = useCallback(() => {
    setUploadOpen(false)
    // JobSnapshotPanel only refetches when job.id changes — force a remount
    // to pick up the freshly-generated estimate (detected scope, line items)
    // it wouldn't otherwise see until the builder navigates away and back.
    setRefreshKey((k) => k + 1)
    setToast({ tone: 'info', message: 'Estimate ready — review it below.' })
  }, [])

  const handleQuoteSend = useCallback(() => {
    setToast({ tone: 'info', message: "Quote sent to client. WorkA has logged it to this job's communication history." })
  }, [])

  const handleQuoteRevise = useCallback(async (quoteId: string) => {
    setViewingQuoteId(null)
    try {
      const res = await fetch(`/api/quotes/${quoteId}/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builder_id: builderId }),
      })
      const data = await res.json()
      if (!res.ok || !data.version) throw new Error()
      setRefreshKey((k) => k + 1)
      setToast({ tone: 'info', message: `Quote v${data.version} created. Resolve any new items before sending.` })
    } catch {
      setToast({ tone: 'error', message: "Couldn't create a revised quote — try again." })
    }
  }, [builderId])

  const handleQuoteExportPdf = useCallback((quoteId: string) => {
    window.open(`/api/quotes/${quoteId}/export-pdf`, '_blank')
    setViewingQuoteId(null)
  }, [])

  if (notFound) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-16 text-center">
        <p style={{ color: 'var(--text-secondary)' }}>Job not found, or you don't have access to it.</p>
        <button className="btn-secondary px-4 py-2 text-sm mt-4" onClick={() => router.push('/jobs')}>Back to Jobs</button>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-4">
        <button className="text-sm flex items-center gap-1" style={{ color: 'var(--text-secondary)' }} onClick={() => router.push('/jobs')}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" /></svg>
          Jobs
        </button>
        {job && (
          <div className="flex items-center gap-2">
            <button className="btn-secondary px-3 py-1.5 text-sm" onClick={() => setVariationDrawerOpen(true)}>+ Raise variation</button>
            {job.status === 'active' && (
              <button className="btn-secondary px-3 py-1.5 text-sm" onClick={() => setCloseOutOpen(true)}>Close out job</button>
            )}
          </div>
        )}
      </div>

      {toast && (
        <div
          className="text-sm px-3 py-2.5 rounded-[6px] mb-4"
          style={toast.tone === 'error'
            ? { background: 'rgba(244,67,54,0.1)', color: 'var(--status-red)' }
            : { background: 'var(--pill-awaiting-bg)', color: 'var(--pill-awaiting-text)' }}
        >
          {toast.message}
        </div>
      )}

      {job ? (
        <JobSnapshotPanel
          key={refreshKey}
          job={job}
          builderId={builderId}
          onClose={() => router.push('/jobs')}
          onUploadPlans={handleUploadPlans}
          onViewQuote={(quoteId) => setViewingQuoteId(quoteId)}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-20 rounded-[6px] animate-pulse" style={{ background: 'var(--bg-surface)' }} />)}
        </div>
      )}

      {job && (
        <UploadPanel
          isOpen={uploadOpen}
          onClose={() => setUploadOpen(false)}
          job={job as UploadPanelJob}
          builderId={builderId}
          onIntakeComplete={handleIntakeComplete}
        />
      )}

      {job && (
        <AddVariationDrawer
          open={variationDrawerOpen}
          jobId={job.id}
          onClose={() => setVariationDrawerOpen(false)}
          onCreated={() => {
            setVariationDrawerOpen(false)
            setRefreshKey((k) => k + 1)
            setToast({ tone: 'info', message: 'Variation raised — approve or reject it from the pending list below.' })
          }}
        />
      )}

      {job && (
        <CloseOutJobDrawer
          open={closeOutOpen}
          jobId={job.id}
          onClose={() => setCloseOutOpen(false)}
          onClosed={(result) => {
            setCloseOutOpen(false)
            setRefreshKey((k) => k + 1)
            refetchJob()
            setToast({ tone: 'info', message: closeOutMessage(result) })
          }}
        />
      )}

      {viewingQuoteId && (
        <QuoteView
          quoteId={viewingQuoteId}
          builderId={builderId}
          onClose={() => setViewingQuoteId(null)}
          onSend={handleQuoteSend}
          onRevise={handleQuoteRevise}
          onExportPdf={handleQuoteExportPdf}
        />
      )}
    </div>
  )
}
