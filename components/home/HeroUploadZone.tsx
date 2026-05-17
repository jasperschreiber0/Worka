'use client'

import { useCallback, useRef, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

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

// ─── Component ────────────────────────────────────────────────────────────────

export default function HeroUploadZone() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [redirecting, setRedirecting] = useState(false)
  const [isTouchDevice, setIsTouchDevice] = useState(false)

  useEffect(() => {
    setIsTouchDevice(
      typeof window !== 'undefined' && 'ontouchstart' in window
    )
  }, [])

  const handleFilesSelected = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return
      const valid = Array.from(files).some(isAcceptedFile)
      if (!valid) return
      setRedirecting(true)
      setTimeout(() => {
        router.push('/chat?action=new_quote')
      }, 800)
    },
    [router]
  )

  // ── Drag events ──────────────────────────────────────────────────────────────

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
      handleFilesSelected(e.dataTransfer.files)
    },
    [handleFilesSelected]
  )

  // ── File input change ────────────────────────────────────────────────────────

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      handleFilesSelected(e.target.files)
    },
    [handleFilesSelected]
  )

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleSamplePlans = useCallback(() => {
    setRedirecting(true)
    setTimeout(() => {
      router.push('/chat?action=sample_quote')
    }, 300)
  }, [router])

  // ── Render ────────────────────────────────────────────────────────────────────

  if (redirecting) {
    return (
      <div className="rounded-xl border-2 border-brand-500 bg-brand-50 px-8 py-10 flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm font-medium text-brand-700">Opening WorkA...</p>
      </div>
    )
  }

  return (
    <div
      className={`rounded-xl border-2 transition-colors duration-150 ${
        dragOver
          ? 'border-brand-500 bg-brand-50'
          : 'border-dashed border-slate-300 bg-white'
      }`}
      onDragOver={isTouchDevice ? undefined : handleDragOver}
      onDragLeave={isTouchDevice ? undefined : handleDragLeave}
      onDrop={isTouchDevice ? undefined : handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS}
        multiple
        className="sr-only"
        onChange={handleInputChange}
        aria-label="Upload plans"
      />

      <div className="px-8 py-10 flex flex-col items-center gap-6">
        {/* Drop zone icon + text — hidden on touch */}
        {!isTouchDevice && (
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="w-12 h-12 rounded-full bg-brand-50 border border-brand-200 flex items-center justify-center">
              <svg
                className="w-6 h-6 text-brand-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m6.75 12-3-3m0 0-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                />
              </svg>
            </div>
            <p className="text-base font-medium text-slate-700">
              Drop your plans here
            </p>
            <p className="text-sm text-slate-400">
              PDF, DWG, or photos accepted
            </p>
          </div>
        )}

        {/* Buttons */}
        <div className="flex flex-col sm:flex-row gap-3 w-full sm:w-auto">
          <button
            onClick={openFilePicker}
            className="btn-primary px-6 py-3 text-base"
          >
            Upload plans
          </button>
          <button
            onClick={handleSamplePlans}
            className="btn-secondary px-6 py-3 text-base"
          >
            Try sample plans
          </button>
        </div>
      </div>
    </div>
  )
}
