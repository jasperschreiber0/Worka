'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import ChatInterface, { type PendingEmailDraft } from '@/components/chat/ChatInterface'
import JobSnapshotPanel from '@/components/job/JobSnapshotPanel'
import MobileJobSheet from '@/components/job/MobileJobSheet'
import type { ActiveJob } from '@/components/job/JobSnapshotPanel'

// ─── Document type labels (mirrors classify-document API) ─────────────────────

const TYPE_LABELS: Record<string, string> = {
  plan: 'Plans',
  receipt: 'Receipt',
  supplier_quote: 'Supplier Quote',
  variation_request: 'Variation Request',
  certificate: 'Certificate',
  contract: 'Contract',
  photo: 'Site Photo',
  unknown: 'Document',
}

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
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null)
  const consumedRef = useRef(false)

  const [globalDragOver, setGlobalDragOver] = useState(false)
  const [droppedFiles, setDroppedFiles] = useState<Array<{ file: File; type: string; label: string }>>([])
  const dragContainerRef = useRef<HTMLDivElement>(null)

  // Decode base64 files staged in sessionStorage by HeroUploadZone
  function popStagedFiles(): File[] {
    try {
      const raw = sessionStorage.getItem('worka_pending_files')
      if (!raw) return []
      sessionStorage.removeItem('worka_pending_files')
      const entries = JSON.parse(raw) as Array<{ name: string; type: string; data: string }>
      return entries.map(({ name, type, data }) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
        return new File([bytes], name, { type })
      })
    } catch {
      return []
    }
  }

  useEffect(() => {
    if (consumedRef.current) return
    const action = searchParams.get('action')
    const jobId = searchParams.get('job')

    if (action === 'upload_plans') {
      consumedRef.current = true
      const files = popStagedFiles()
      if (files.length > 0) setPendingFiles(files)
      router.replace('/chat')
      return
    }

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

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setGlobalDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const container = dragContainerRef.current
    if (!e.relatedTarget || (container && !container.contains(e.relatedTarget as Node))) {
      setGlobalDragOver(false)
    }
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setGlobalDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return

    const results = await Promise.all(
      files.map(async (file) => {
        try {
          const fd = new FormData()
          fd.append('file', file)
          const res = await fetch('/api/classify-document', { method: 'POST', body: fd })
          if (!res.ok) throw new Error('classify failed')
          const result = await res.json() as { type: string; summary?: string }
          return { file, type: result.type, label: result.summary ?? TYPE_LABELS[result.type] ?? 'Document' }
        } catch {
          return { file, type: 'unknown', label: TYPE_LABELS['unknown'] }
        }
      })
    )
    setDroppedFiles(results)
  }, [])

  const handleDroppedFilesConsumed = useCallback(() => {
    setDroppedFiles([])
  }, [])

  return (
    <div
      ref={dragContainerRef}
      className="h-screen flex overflow-hidden bg-white relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* ── Drag overlay ──────────────────────────────────────────────────── */}
      {globalDragOver && (
        <div className="absolute inset-0 z-50 bg-brand-500/10 border-4 border-brand-500 border-dashed rounded-lg flex items-center justify-center pointer-events-none">
          <div className="bg-white rounded-2xl px-8 py-6 shadow-2xl text-center">
            <p className="text-xl font-bold text-brand-600">Drop files here</p>
            <p className="text-sm text-slate-500 mt-1">Plans, receipts, drawings — anything</p>
          </div>
        </div>
      )}

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
          activeJobAddress={activeJob?.address ?? null}
          pendingFiles={pendingFiles}
          onPendingFilesConsumed={() => setPendingFiles(null)}
          droppedFiles={droppedFiles}
          onDroppedFilesConsumed={handleDroppedFilesConsumed}
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
