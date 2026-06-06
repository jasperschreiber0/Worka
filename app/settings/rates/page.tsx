'use client'

import { useCallback, useRef, useState } from 'react'
import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExtractedCategory {
  name: string
  count: number
}

interface ExtractionResult {
  fileName: string
  totalRates: number
  categories: ExtractedCategory[]
}

type PageState =
  | { kind: 'idle' }
  | { kind: 'processing'; fileName: string; status: string }
  | { kind: 'success'; result: ExtractionResult }
  | { kind: 'error'; message: string }

// ─── Demo extraction simulation ───────────────────────────────────────────────

const PROCESSING_STEPS = [
  'Reading file and detecting format…',
  'Identifying trade categories…',
  'Extracting labour rates…',
  'Extracting material costs…',
  'Matching to WorkA rate library…',
]

async function simulateExtraction(fileName: string): Promise<ExtractionResult> {
  await new Promise((r) => setTimeout(r, 2800))
  return {
    fileName,
    totalRates: 34,
    categories: [
      { name: 'Concrete & site works', count: 7 },
      { name: 'Framing & structural', count: 6 },
      { name: 'Roofing', count: 4 },
      { name: 'Electrical', count: 5 },
      { name: 'Plumbing', count: 5 },
      { name: 'Fit-out & finishes', count: 7 },
    ],
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function RatesSettingsPage() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [state, setState] = useState<PageState>({ kind: 'idle' })
  const [stepIndex, setStepIndex] = useState(0)

  const handleFile = useCallback(async (file: File) => {
    setState({ kind: 'processing', fileName: file.name, status: PROCESSING_STEPS[0] })
    setStepIndex(0)

    // Cycle through status messages
    for (let i = 1; i < PROCESSING_STEPS.length; i++) {
      await new Promise((r) => setTimeout(r, 500))
      setStepIndex(i)
      setState((s) =>
        s.kind === 'processing' ? { ...s, status: PROCESSING_STEPS[i] } : s
      )
    }

    try {
      const result = await simulateExtraction(file.name)
      setState({ kind: 'success', result })
    } catch {
      setState({ kind: 'error', message: 'Failed to extract rates. Check the file format and try again.' })
    }
  }, [])

  const handleFilesSelected = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return
      const file = files[0]
      const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
      if (!['csv', 'pdf'].includes(ext)) return
      handleFile(file)
    },
    [handleFile]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      handleFilesSelected(e.dataTransfer.files)
    },
    [handleFilesSelected]
  )

  return (
    <div className="min-h-screen bg-slate-50">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back to WorkA
          </Link>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8">
        {/* ── Title ───────────────────────────────────────────────────────── */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Rates & pricing</h1>
          <p className="mt-1.5 text-slate-600">
            Import your historical rates so WorkA can quote accurately from day one.
          </p>
        </div>

        {/* ── Upload section ──────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Upload rate sheet
            </h2>
            <a
              href="/rate-sheet-template.csv"
              download
              className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:text-brand-700 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download template
            </a>
          </div>

          {/* Upload zone — only shown when idle */}
          {state.kind === 'idle' && (
            <div
              className={`rounded-xl border-2 transition-colors duration-150 bg-white cursor-pointer ${
                dragOver ? 'border-brand-500 bg-brand-50' : 'border-dashed border-slate-300'
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              aria-label="Upload rate sheet"
              onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.pdf"
                className="sr-only"
                onChange={(e) => handleFilesSelected(e.target.files)}
              />
              <div className="flex flex-col items-center gap-2 py-10 text-center px-6">
                <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center">
                  <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-slate-700">Drop your CSV here, or click to browse</p>
                <p className="text-xs text-slate-400">CSV or PDF — past quotes, invoices, supplier price lists</p>
              </div>
            </div>
          )}

          {/* Processing state */}
          {state.kind === 'processing' && (
            <div className="bg-white rounded-xl border border-slate-200 px-4 py-4 space-y-3">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 text-brand-500 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{state.fileName}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{state.status}</p>
                </div>
              </div>
              {/* Progress bar */}
              <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand-500 rounded-full transition-all duration-500"
                  style={{ width: `${((stepIndex + 1) / PROCESSING_STEPS.length) * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Success state */}
          {state.kind === 'success' && (
            <div className="space-y-3">
              {/* Summary card */}
              <div className="bg-white rounded-xl border border-green-200 px-4 py-4">
                <div className="flex items-start gap-3">
                  <span className="flex-shrink-0 w-7 h-7 rounded-full bg-green-100 flex items-center justify-center mt-0.5">
                    <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-900">
                      {state.result.totalRates} rates extracted
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      from &ldquo;{state.result.fileName}&rdquo;
                    </p>
                  </div>
                  <button
                    onClick={() => setState({ kind: 'idle' })}
                    className="flex-shrink-0 text-slate-400 hover:text-slate-600 transition-colors"
                    aria-label="Upload another file"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                {/* Category breakdown */}
                <div className="mt-4 border-t border-slate-100 pt-3 space-y-2">
                  {state.result.categories.map((cat) => (
                    <div key={cat.name} className="flex items-center justify-between gap-3">
                      <span className="text-sm text-slate-700">{cat.name}</span>
                      <span className="text-xs font-medium text-slate-500 flex-shrink-0">
                        {cat.count} rate{cat.count !== 1 ? 's' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-3">
                <button className="btn-primary flex-1 py-2.5 text-sm">
                  Apply rates
                </button>
                <button
                  onClick={() => setState({ kind: 'idle' })}
                  className="btn-secondary px-4 py-2.5 text-sm"
                >
                  Upload another
                </button>
              </div>
            </div>
          )}

          {/* Error state */}
          {state.kind === 'error' && (
            <div className="bg-white rounded-xl border border-red-200 px-4 py-4">
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 w-7 h-7 rounded-full bg-red-100 flex items-center justify-center mt-0.5">
                  <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-900">Extraction failed</p>
                  <p className="text-xs text-slate-500 mt-0.5">{state.message}</p>
                </div>
              </div>
              <button
                onClick={() => setState({ kind: 'idle' })}
                className="mt-3 btn-secondary w-full py-2 text-sm"
              >
                Try again
              </button>
            </div>
          )}
        </section>

        {/* ── Help text ───────────────────────────────────────────────────── */}
        {state.kind === 'idle' && (
          <div className="mt-6 bg-slate-100 rounded-xl px-5 py-4">
            <p className="text-sm text-slate-600">
              <span className="font-semibold text-slate-700">What to upload:</span>{' '}
              Any CSV or PDF containing your labour rates, material costs, or supplier price lists.
              WorkA maps them to its 13 trade categories automatically.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
