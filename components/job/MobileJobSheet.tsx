'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import JobSnapshotPanel, { type ActiveJob } from './JobSnapshotPanel'

// ─── Props ────────────────────────────────────────────────────────────────────

interface MobileJobSheetProps {
  job: ActiveJob
  onClose: () => void
  onViewQuote?: (quoteId: string) => void
  onAddTask?: (jobAddress: string) => void
}

// ─── Inner sheet (rendered in portal) ────────────────────────────────────────

function MobileJobSheetInner({ job, onClose, onViewQuote, onAddTask }: MobileJobSheetProps) {
  const [visible, setVisible] = useState(false)
  const sheetRef = useRef<HTMLDivElement>(null)

  // Animate in on mount
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setVisible(true)
    })
    return () => cancelAnimationFrame(raf)
  }, [])

  // Close handler: animate out first, then call onClose
  function handleClose() {
    setVisible(false)
    setTimeout(onClose, 300)
  }

  // Trap focus inside sheet and close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        handleClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      {/* Backdrop — hidden on md+ (side panel is used there instead) */}
      <div
        className={`md:hidden fixed inset-0 z-30 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ background: 'rgba(0,0,0,0.5)' }}
        onClick={handleClose}
        aria-hidden="true"
      />

      {/* Sheet — hidden on md+ (side panel is used there instead) */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Job snapshot: ${job.address}`}
        className={`md:hidden fixed inset-x-0 bottom-0 z-40 rounded-t-2xl shadow-2xl max-h-[85vh] flex flex-col transition-transform duration-300 ease-in-out ${visible ? 'translate-y-0' : 'translate-y-full'}`}
        style={{ backgroundColor: 'var(--bg-surface)', border: '0.5px solid var(--bg-border)' }}
      >
        {/* Drag handle */}
        <div className="flex-shrink-0 flex justify-center pt-3 pb-1">
          <div className="w-12 h-1.5 rounded-full" style={{ backgroundColor: 'var(--bg-border)' }} aria-hidden="true" />
        </div>

        {/* Content — reuse JobSnapshotPanel */}
        <div className="flex-1 overflow-y-auto">
          <JobSnapshotPanel job={job} onClose={handleClose} onViewQuote={onViewQuote} onAddTask={(addr) => { handleClose(); onAddTask?.(addr) }} />
        </div>
      </div>
    </>
  )
}

// ─── Portal wrapper ───────────────────────────────────────────────────────────

export default function MobileJobSheet({ job, onClose, onViewQuote, onAddTask }: MobileJobSheetProps) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    return () => setMounted(false)
  }, [])

  if (!mounted) return null

  return createPortal(
    <MobileJobSheetInner job={job} onClose={onClose} onViewQuote={onViewQuote} onAddTask={onAddTask} />,
    document.body
  )
}
