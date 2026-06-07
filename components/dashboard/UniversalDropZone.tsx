'use client'

import { useState, useRef, useCallback, type DragEvent } from 'react'
import { useRouter } from 'next/navigation'
import type { ClassificationResult } from '@/app/api/classify-document/route'

interface UniversalDropZoneProps {
  onJobOpen?: (jobId: string) => void
}

const TYPE_LABELS: Record<ClassificationResult['type'], string> = {
  plan: 'Plans',
  receipt: 'Receipt',
  supplier_quote: 'Supplier Quote',
  variation_request: 'Variation Request',
  certificate: 'Certificate',
  contract: 'Contract',
  photo: 'Site Photo',
  unknown: 'Document',
}

// Map each document type to CSS var colors
const TYPE_COLORS: Record<ClassificationResult['type'], { color: string; bg: string }> = {
  plan: { color: 'var(--status-blue)', bg: 'rgba(59, 130, 246, 0.12)' },
  receipt: { color: 'var(--status-green)', bg: 'rgba(34, 197, 94, 0.12)' },
  supplier_quote: { color: 'var(--orange-primary)', bg: 'rgba(255, 107, 43, 0.12)' },
  variation_request: { color: 'var(--status-amber)', bg: 'rgba(255, 171, 0, 0.12)' },
  certificate: { color: 'var(--status-green)', bg: 'rgba(20, 184, 166, 0.12)' },
  contract: { color: 'var(--text-secondary)', bg: 'var(--bg-elevated)' },
  photo: { color: 'var(--status-red)', bg: 'rgba(239, 68, 68, 0.12)' },
  unknown: { color: 'var(--text-secondary)', bg: 'var(--bg-elevated)' },
}

export default function UniversalDropZone({ onJobOpen }: UniversalDropZoneProps) {
  const [dragging, setDragging] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [result, setResult] = useState<ClassificationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  const classify = useCallback(async (file: File) => {
    setFileName(file.name)
    setResult(null)
    setError(null)
    setProcessing(true)

    const formData = new FormData()
    formData.append('file', file)

    try {
      const res = await fetch('/api/classify-document', { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not classify this document.')
      } else {
        setResult(data as ClassificationResult)
      }
    } catch {
      setError('Upload failed — please try again.')
    } finally {
      setProcessing(false)
    }
  }, [])

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) classify(file)
  }, [classify])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) classify(file)
  }, [classify])

  const handleQuestionSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    if (!question.trim()) return
    router.push(`/chat?q=${encodeURIComponent(question.trim())}`)
  }, [question, router])

  const reset = useCallback(() => {
    setResult(null)
    setError(null)
    setFileName(null)
    setProcessing(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  const handleActionClick = useCallback((intent: string) => {
    const routes: Record<string, string> = {
      create_quote: '/chat?action=new_quote',
      attach_to_job: '/chat',
      add_to_costs: '/chat',
      accept_supplier_quote: '/chat',
      compare_supplier: '/chat',
      update_budget: '/chat',
      create_variation: '/chat',
      store_certificate: '/chat',
    }
    router.push(routes[intent] ?? '/chat')
  }, [router])

  return (
    <div className="w-full">
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Drop zone */}
      {!result && !processing && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className="relative rounded-xl border-2 border-dashed cursor-pointer transition-all duration-200"
          style={{
            borderColor: dragging ? 'var(--orange-primary)' : 'var(--bg-border)',
            background: dragging ? 'rgba(255, 107, 43, 0.06)' : 'var(--bg-surface)',
            transform: dragging ? 'scale(1.01)' : undefined,
          }}
          onMouseEnter={(e) => {
            if (!dragging) {
              (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--orange-primary)'
              ;(e.currentTarget as HTMLDivElement).style.background = 'rgba(255, 107, 43, 0.04)'
            }
          }}
          onMouseLeave={(e) => {
            if (!dragging) {
              (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--bg-border)'
              ;(e.currentTarget as HTMLDivElement).style.background = 'var(--bg-surface)'
            }
          }}
        >
          <div className="px-8 py-10 flex flex-col items-center gap-3">
            {/* Upload icon */}
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center transition-colors"
              style={{
                background: dragging ? 'rgba(255, 107, 43, 0.15)' : 'var(--bg-elevated)',
              }}
            >
              <svg
                className="w-6 h-6"
                style={{ color: dragging ? 'var(--orange-primary)' : 'var(--text-tertiary)' }}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
            </div>

            <div className="text-center">
              <p className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                Drop anything here
              </p>
              <p className="text-[13px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                Plans · Receipts · Supplier quotes · Emails · Photos
              </p>
            </div>

            <div className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
              <form onSubmit={handleQuestionSubmit} className="flex gap-2 mt-1">
                <input
                  ref={inputRef}
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Or ask anything..."
                  className="input flex-1 text-[13px] py-2"
                />
                <button
                  type="submit"
                  disabled={!question.trim()}
                  className="btn-primary py-2 px-4 text-[13px] disabled:opacity-40"
                >
                  Ask
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Processing state */}
      {processing && (
        <div
          className="rounded-xl border px-8 py-10 flex flex-col items-center gap-4"
          style={{ background: 'var(--bg-surface)', borderColor: 'var(--bg-border)' }}
        >
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center"
            style={{ background: 'rgba(255, 107, 43, 0.12)' }}
          >
            <svg
              className="w-6 h-6 animate-spin"
              style={{ color: 'var(--orange-primary)' }}
              fill="none" viewBox="0 0 24 24"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </div>
          <div className="text-center">
            <p className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              Analysing {fileName}
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
              WORKA is reading this document...
            </p>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && !processing && (
        <div
          className="rounded-xl border px-6 py-5 flex items-start gap-3"
          style={{ background: 'rgba(239, 68, 68, 0.08)', borderColor: 'rgba(239, 68, 68, 0.3)' }}
        >
          <svg
            className="w-5 h-5 flex-shrink-0 mt-0.5"
            style={{ color: 'var(--status-red)' }}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-[13px]" style={{ color: 'var(--status-red)' }}>{error}</p>
            <button
              onClick={reset}
              className="mt-2 text-[11px] font-medium"
              style={{ color: 'var(--status-red)' }}
            >
              Try again →
            </button>
          </div>
        </div>
      )}

      {/* Result card */}
      {result && !processing && (
        <div
          className="rounded-xl border overflow-hidden"
          style={{ background: 'var(--bg-surface)', borderColor: 'var(--orange-primary)' }}
        >
          {/* Header */}
          <div
            className="px-5 py-4 border-b flex items-start gap-3"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--bg-border)' }}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
                  style={{
                    color: TYPE_COLORS[result.type].color,
                    background: TYPE_COLORS[result.type].bg,
                  }}
                >
                  {TYPE_LABELS[result.type]}
                </span>
                {result.confidence >= 80 && (
                  <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    {result.confidence}% confident
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {result.summary}
              </p>
              {result.job_match_hint && (
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  Job: <span className="font-medium">{result.job_match_hint}</span>
                </p>
              )}
              {result.amount && (
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  Amount: <span className="font-medium">${result.amount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</span>
                </p>
              )}
              {result.supplier && (
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  Supplier: <span className="font-medium">{result.supplier}</span>
                </p>
              )}
            </div>
            <button
              onClick={reset}
              className="flex-shrink-0"
              style={{ color: 'var(--text-tertiary)' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-tertiary)')}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Questions */}
          {result.questions.length > 0 && (
            <div className="px-5 py-3 border-b" style={{ borderColor: 'var(--bg-border)' }}>
              <p className="text-[11px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                To proceed I need:
              </p>
              <ul className="space-y-1">
                {result.questions.map((q, i) => (
                  <li key={i} className="text-[13px] flex items-start gap-2" style={{ color: 'var(--text-primary)' }}>
                    <span className="font-bold flex-shrink-0" style={{ color: 'var(--orange-primary)' }}>·</span>
                    {q}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Actions */}
          {result.actions.length > 0 && (
            <div className="px-5 py-4 flex flex-wrap gap-2">
              {result.actions.map((action, i) => (
                <button
                  key={i}
                  onClick={() => handleActionClick(action.intent)}
                  className={action.primary ? 'btn-primary text-[13px] py-2 px-4' : 'btn-secondary text-[13px] py-2 px-4'}
                >
                  {action.label}
                </button>
              ))}
              <button onClick={reset} className="btn-ghost text-[13px] py-2 px-4 ml-auto">
                Drop another
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
