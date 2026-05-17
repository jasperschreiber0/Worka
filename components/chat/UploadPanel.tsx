'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UploadPanelJob {
  id: string
  address: string
  status: string
}

export interface UploadPanelProps {
  isOpen: boolean
  onClose: () => void
  job: UploadPanelJob
}

interface SelectedFile {
  file: File
  id: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function generateFileId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

// ─── Accepted file types ──────────────────────────────────────────────────────

const ACCEPTED_EXTENSIONS = '.pdf,.dwg,.jpg,.jpeg,.png,.heic'
const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
]

function isAcceptedFile(file: File): boolean {
  if (ACCEPTED_MIME_TYPES.includes(file.type)) return true
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return ['pdf', 'dwg', 'jpg', 'jpeg', 'png', 'heic'].includes(ext)
}

// ─── Inner component (rendered inside portal) ─────────────────────────────────

function UploadPanelInner({ isOpen, onClose, job }: UploadPanelProps) {
  const [visible, setVisible] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [files, setFiles] = useState<SelectedFile[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  // Animate in/out
  useEffect(() => {
    if (isOpen) {
      setMounted(true)
      const id = setTimeout(() => setVisible(true), 10)
      return () => clearTimeout(id)
    } else {
      setVisible(false)
      const id = setTimeout(() => {
        setMounted(false)
        setFiles([])
        setDragOver(false)
      }, 300)
      return () => clearTimeout(id)
    }
  }, [isOpen])

  // Focus close button on open
  useEffect(() => {
    if (visible) {
      closeButtonRef.current?.focus()
    }
  }, [visible])

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  // Lock body scroll
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  // Cleanup toast timeout
  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current)
    }
  }, [])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current)
    toastTimeoutRef.current = setTimeout(() => setToast(null), 3000)
  }, [])

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const arr = Array.from(incoming)
    const accepted = arr.filter(isAcceptedFile)
    if (accepted.length < arr.length) {
      showToast('Some files were skipped — only PDF, DWG, JPG, PNG, and HEIC are accepted.')
    }
    setFiles((prev) => [
      ...prev,
      ...accepted.map((file) => ({ file, id: generateFileId() })),
    ])
  }, [showToast])

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id))
  }, [])

  // Drag events
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      setDragOver(false)
      if (e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files)
      }
    },
    [addFiles]
  )

  const handleBrowseClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        addFiles(e.target.files)
        // Reset so same file can be re-selected
        e.target.value = ''
      }
    },
    [addFiles]
  )

  const handleUpload = useCallback(() => {
    showToast('File intake coming in Session 5')
  }, [showToast])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose()
    },
    [onClose]
  )

  if (!mounted) return null

  return (
    // Overlay — backdrop on mobile, transparent on desktop (panel slides in from right)
    <div
      className={[
        'fixed inset-0 z-50',
        'flex items-end sm:items-stretch justify-end',
        'transition-opacity duration-300',
        visible ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
      style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      onClick={handleBackdropClick}
      aria-modal="true"
      role="dialog"
      aria-label={`Upload plans — ${job.address}`}
    >
      {/* Panel */}
      <div
        className={[
          // Layout
          'relative flex flex-col',
          // Size: full-width bottom sheet on mobile, fixed-width sidebar on desktop
          'w-full sm:w-[420px] sm:max-w-[90vw]',
          'h-[90dvh] sm:h-full',
          // Style
          'bg-white',
          'rounded-t-2xl sm:rounded-none sm:rounded-l-2xl',
          'shadow-2xl',
          // Slide-in transitions
          'transition-transform duration-300 ease-out',
          visible
            ? 'translate-y-0 sm:translate-y-0 sm:translate-x-0'
            : 'translate-y-full sm:translate-y-0 sm:translate-x-full',
        ].join(' ')}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-200 flex-shrink-0">
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors flex-shrink-0"
            aria-label="Close upload panel"
          >
            {/* Left arrow icon */}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M10 3L5 8l5 5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wide leading-none mb-0.5">
              Upload plans
            </p>
            <h2 className="text-base font-semibold text-slate-900 truncate leading-tight">
              {job.address}
            </h2>
          </div>
        </div>

        {/* ── Body ──────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {/* Drop zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={handleBrowseClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleBrowseClick()
              }
            }}
            aria-label="Drop zone — click or drag files here"
            className={[
              'rounded-xl border-2 border-dashed cursor-pointer',
              'flex flex-col items-center justify-center gap-3',
              'px-6 py-8 text-center',
              'transition-colors duration-150',
              dragOver
                ? 'border-brand-500 bg-brand-50'
                : 'border-slate-300 bg-slate-50 hover:border-brand-400 hover:bg-brand-50',
            ].join(' ')}
          >
            {files.length === 0 ? (
              <>
                {/* File icon */}
                <div className="w-12 h-12 rounded-xl bg-white border border-slate-200 shadow-sm flex items-center justify-center">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                    className="text-slate-400"
                  >
                    <path
                      d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M14 2v6h6M12 12v6M9 15l3-3 3 3"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-700">
                    Drop plans here
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">or tap to browse</p>
                </div>
                <p className="text-xs text-slate-400">PDF · DWG · Images accepted</p>
              </>
            ) : (
              <div className="w-full space-y-2" onClick={(e) => e.stopPropagation()}>
                {files.map((sf) => (
                  <div
                    key={sf.id}
                    className="flex items-center gap-3 bg-white border border-slate-200 rounded-lg px-3 py-2.5 text-left"
                  >
                    {/* File type icon */}
                    <div className="w-8 h-8 rounded-md bg-brand-50 border border-brand-100 flex items-center justify-center flex-shrink-0">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                        className="text-brand-500"
                      >
                        <path
                          d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M14 2v6h6"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate leading-tight">
                        {sf.file.name}
                      </p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {formatFileSize(sf.file.size)}
                      </p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        removeFile(sf.id)
                      }}
                      className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
                      aria-label={`Remove ${sf.file.name}`}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                        <path
                          d="M1 1l8 8M9 1L1 9"
                          stroke="currentColor"
                          strokeWidth="1.75"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                  </div>
                ))}
                {/* "Add more" hint */}
                <button
                  onClick={handleBrowseClick}
                  className="w-full text-xs text-brand-600 hover:text-brand-700 font-medium py-1.5 text-center transition-colors"
                >
                  + Add more files
                </button>
              </div>
            )}
          </div>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_EXTENSIONS}
            onChange={handleFileInputChange}
            className="sr-only"
            aria-hidden="true"
            tabIndex={-1}
          />

          {/* Accepted file types list */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
              Accepted file types
            </p>
            <ul className="space-y-1 text-sm text-slate-600">
              <li className="flex items-start gap-2">
                <span className="text-slate-400 mt-0.5" aria-hidden="true">•</span>
                Architectural plans (PDF/DWG)
              </li>
              <li className="flex items-start gap-2">
                <span className="text-slate-400 mt-0.5" aria-hidden="true">•</span>
                Site photos (JPG/PNG)
              </li>
              <li className="flex items-start gap-2">
                <span className="text-slate-400 mt-0.5" aria-hidden="true">•</span>
                Engineer drawings
              </li>
            </ul>
          </div>

          {/* Info text */}
          <p className="text-sm text-slate-500 leading-relaxed">
            WorkA will extract quantities and draft your quote. You review everything before it
            goes anywhere.
          </p>
        </div>

        {/* ── Footer CTA ────────────────────────────────────────────── */}
        <div className="flex-shrink-0 px-5 py-4 border-t border-slate-200 bg-white">
          <button
            onClick={handleUpload}
            disabled={files.length === 0}
            className="w-full btn-primary py-3 text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            Upload plans
          </button>
        </div>
      </div>

      {/* ── Toast ────────────────────────────────────────────────────── */}
      {toast && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-slate-800 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg pointer-events-none"
          role="status"
          aria-live="polite"
        >
          {toast}
        </div>
      )}
    </div>
  )
}

// ─── Portal wrapper ───────────────────────────────────────────────────────────

export default function UploadPanel(props: UploadPanelProps) {
  const [portalTarget, setPortalTarget] = useState<Element | null>(null)

  useEffect(() => {
    setPortalTarget(document.body)
  }, [])

  if (!portalTarget) return null
  return createPortal(<UploadPanelInner {...props} />, portalTarget)
}
