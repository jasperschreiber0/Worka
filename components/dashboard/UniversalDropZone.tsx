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

const TYPE_COLORS: Record<ClassificationResult['type'], string> = {
  plan: 'bg-blue-100 text-blue-800',
  receipt: 'bg-green-100 text-green-800',
  supplier_quote: 'bg-purple-100 text-purple-800',
  variation_request: 'bg-amber-100 text-amber-800',
  certificate: 'bg-teal-100 text-teal-800',
  contract: 'bg-slate-100 text-slate-700',
  photo: 'bg-rose-100 text-rose-800',
  unknown: 'bg-slate-100 text-slate-600',
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
          className={`
            relative rounded-xl border-2 border-dashed cursor-pointer transition-all duration-200
            ${dragging
              ? 'border-brand-500 bg-brand-50 scale-[1.01]'
              : 'border-slate-300 bg-white hover:border-brand-400 hover:bg-brand-50/40'}
          `}
        >
          <div className="px-8 py-10 flex flex-col items-center gap-3">
            {/* Upload icon */}
            <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${dragging ? 'bg-brand-100' : 'bg-slate-100'}`}>
              <svg className={`w-6 h-6 ${dragging ? 'text-brand-600' : 'text-slate-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
            </div>

            <div className="text-center">
              <p className="text-base font-semibold text-slate-800">Drop anything here</p>
              <p className="text-sm text-slate-500 mt-0.5">Plans · Receipts · Supplier quotes · Emails · Photos</p>
            </div>

            <div className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
              <form onSubmit={handleQuestionSubmit} className="flex gap-2 mt-1">
                <input
                  ref={inputRef}
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Or ask anything..."
                  className="input flex-1 text-sm py-2"
                />
                <button
                  type="submit"
                  disabled={!question.trim()}
                  className="btn-primary py-2 px-4 text-sm disabled:opacity-40"
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
        <div className="rounded-xl border border-slate-200 bg-white px-8 py-10 flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-brand-50 flex items-center justify-center">
            <svg className="w-6 h-6 text-brand-500 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold text-slate-800">Analysing {fileName}</p>
            <p className="text-xs text-slate-500 mt-0.5">WORKA is reading this document...</p>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && !processing && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-6 py-5 flex items-start gap-3">
          <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-red-700">{error}</p>
            <button onClick={reset} className="mt-2 text-xs font-medium text-red-600 hover:text-red-800">Try again →</button>
          </div>
        </div>
      )}

      {/* Result card */}
      {result && !processing && (
        <div className="rounded-xl border border-brand-200 bg-brand-50 overflow-hidden">
          {/* Header */}
          <div className="px-5 py-4 bg-white border-b border-brand-100 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${TYPE_COLORS[result.type]}`}>
                  {TYPE_LABELS[result.type]}
                </span>
                {result.confidence >= 80 && (
                  <span className="text-xs text-slate-400">{result.confidence}% confident</span>
                )}
              </div>
              <p className="mt-1.5 text-sm font-semibold text-slate-900">{result.summary}</p>
              {result.job_match_hint && (
                <p className="text-xs text-slate-500 mt-0.5">
                  Job: <span className="font-medium">{result.job_match_hint}</span>
                </p>
              )}
              {result.amount && (
                <p className="text-xs text-slate-500 mt-0.5">
                  Amount: <span className="font-medium">${result.amount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</span>
                </p>
              )}
              {result.supplier && (
                <p className="text-xs text-slate-500 mt-0.5">
                  Supplier: <span className="font-medium">{result.supplier}</span>
                </p>
              )}
            </div>
            <button onClick={reset} className="flex-shrink-0 text-slate-400 hover:text-slate-600">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Questions */}
          {result.questions.length > 0 && (
            <div className="px-5 py-3 border-b border-brand-100">
              <p className="text-xs font-semibold text-slate-600 mb-2">To proceed I need:</p>
              <ul className="space-y-1">
                {result.questions.map((q, i) => (
                  <li key={i} className="text-sm text-slate-700 flex items-start gap-2">
                    <span className="text-brand-500 font-bold flex-shrink-0">·</span>
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
                  className={action.primary ? 'btn-primary text-sm py-2 px-4' : 'btn-secondary text-sm py-2 px-4'}
                >
                  {action.label}
                </button>
              ))}
              <button onClick={reset} className="btn-ghost text-sm py-2 px-4 ml-auto">
                Drop another
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
