'use client'

import { useCallback, useRef, useState } from 'react'
import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExtractedCategory {
  name: string
  count: number
}

interface FileResult {
  fileName: string
  totalRates: number
  categories: ExtractedCategory[]
}

interface FileJob {
  file: File
  status: 'queued' | 'processing' | 'done' | 'error'
  stepIndex: number
  statusText: string
  result?: FileResult
  errorMessage?: string
}

type PageState =
  | { kind: 'idle' }
  | { kind: 'running'; jobs: FileJob[] }
  | { kind: 'done'; jobs: FileJob[] }

// ─── Demo extraction simulation ───────────────────────────────────────────────

const PROCESSING_STEPS = [
  'Reading file and detecting format…',
  'Identifying trade categories…',
  'Extracting labour rates…',
  'Extracting material costs…',
  'Matching to WorkA rate library…',
]

// Vary results slightly per file so multi-file results look distinct
const DEMO_CATEGORIES: ExtractedCategory[] = [
  { name: 'Concrete & site works', count: 7 },
  { name: 'Framing & structural', count: 6 },
  { name: 'Roofing', count: 4 },
  { name: 'Electrical', count: 5 },
  { name: 'Plumbing', count: 5 },
  { name: 'Fit-out & finishes', count: 7 },
]

function demoResultForFile(file: File): FileResult {
  // Seed variation based on filename length so multiple files look different
  const seed = file.name.length % 3
  const categories = DEMO_CATEGORIES.map((c, i) => ({
    ...c,
    count: Math.max(1, c.count + (i % 2 === seed ? 2 : -1)),
  }))
  return {
    fileName: file.name,
    totalRates: categories.reduce((s, c) => s + c.count, 0),
    categories,
  }
}

const ACCEPTED_EXTENSIONS = ['.csv', '.pdf']

function isAccepted(file: File) {
  const ext = '.' + (file.name.split('.').pop()?.toLowerCase() ?? '')
  return ACCEPTED_EXTENSIONS.includes(ext)
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function RatesSettingsPage() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [state, setState] = useState<PageState>({ kind: 'idle' })

  const processQueue = useCallback(async (files: File[]) => {
    const jobs: FileJob[] = files.map((f) => ({
      file: f,
      status: 'queued',
      stepIndex: 0,
      statusText: 'Queued',
    }))

    setState({ kind: 'running', jobs: [...jobs] })

    for (let i = 0; i < jobs.length; i++) {
      // Mark as processing
      jobs[i] = { ...jobs[i], status: 'processing', stepIndex: 0, statusText: PROCESSING_STEPS[0] }
      setState({ kind: 'running', jobs: [...jobs] })

      // Step through status messages
      for (let step = 1; step < PROCESSING_STEPS.length; step++) {
        await new Promise((r) => setTimeout(r, 480))
        jobs[i] = { ...jobs[i], stepIndex: step, statusText: PROCESSING_STEPS[step] }
        setState({ kind: 'running', jobs: [...jobs] })
      }

      // Simulate extraction
      await new Promise((r) => setTimeout(r, 600))
      jobs[i] = {
        ...jobs[i],
        status: 'done',
        result: demoResultForFile(jobs[i].file),
      }
      setState({ kind: 'running', jobs: [...jobs] })
    }

    setState({ kind: 'done', jobs: [...jobs] })
  }, [])

  const handleFilesSelected = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return
      const valid = Array.from(files).filter(isAccepted)
      if (valid.length === 0) return
      processQueue(valid)
    },
    [processQueue]
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

  // Merged category totals across all completed files
  const mergedCategories = (() => {
    if (state.kind !== 'done') return []
    const map = new Map<string, number>()
    for (const job of state.jobs) {
      if (job.result) {
        for (const cat of job.result.categories) {
          map.set(cat.name, (map.get(cat.name) ?? 0) + cat.count)
        }
      }
    }
    return Array.from(map.entries()).map(([name, count]) => ({ name, count }))
  })()

  const totalRates = mergedCategories.reduce((s, c) => s + c.count, 0)
  const completedJobs = state.kind === 'done' ? state.jobs.filter((j) => j.status === 'done') : []

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

          {/* ── Idle: drop zone ───────────────────────────────────────────── */}
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
              aria-label="Upload rate sheets"
              onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.pdf"
                multiple
                className="sr-only"
                onChange={(e) => handleFilesSelected(e.target.files)}
              />
              <div className="flex flex-col items-center gap-2 py-10 text-center px-6">
                <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center">
                  <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-slate-700">Drop your files here, or click to browse</p>
                <p className="text-xs text-slate-400">CSV or PDF — you can drop multiple files at once</p>
              </div>
            </div>
          )}

          {/* ── Running: per-file queue ───────────────────────────────────── */}
          {(state.kind === 'running' || state.kind === 'done') && (
            <div className="space-y-2">
              {state.jobs.map((job, i) => (
                <div
                  key={i}
                  className={`bg-white rounded-xl border px-4 py-3 ${
                    job.status === 'done'
                      ? 'border-green-200'
                      : job.status === 'error'
                      ? 'border-red-200'
                      : 'border-slate-200'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {/* Status icon */}
                    {job.status === 'done' && (
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-green-100 flex items-center justify-center">
                        <svg className="w-3.5 h-3.5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </span>
                    )}
                    {job.status === 'error' && (
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-red-100 flex items-center justify-center">
                        <svg className="w-3.5 h-3.5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </span>
                    )}
                    {job.status === 'processing' && (
                      <svg className="w-5 h-5 text-brand-500 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    )}
                    {job.status === 'queued' && (
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center">
                        <svg className="w-3 h-3 text-slate-400" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <circle cx="12" cy="12" r="4" />
                        </svg>
                      </span>
                    )}

                    {/* File name + status */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{job.file.name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {job.status === 'done' && job.result
                          ? `${job.result.totalRates} rates extracted`
                          : job.status === 'error'
                          ? job.errorMessage ?? 'Extraction failed'
                          : job.status === 'queued'
                          ? 'Waiting…'
                          : job.statusText}
                      </p>
                    </div>
                  </div>

                  {/* Progress bar — only while processing */}
                  {job.status === 'processing' && (
                    <div className="mt-2.5 h-1 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-brand-500 rounded-full transition-all duration-500"
                        style={{ width: `${((job.stepIndex + 1) / PROCESSING_STEPS.length) * 100}%` }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Done: combined summary + actions ─────────────────────────── */}
          {state.kind === 'done' && completedJobs.length > 0 && (
            <div className="mt-4 space-y-3">
              <div className="bg-white rounded-xl border border-slate-200 px-4 py-4">
                <p className="text-sm font-semibold text-slate-900 mb-3">
                  {totalRates} rates ready to apply
                  {completedJobs.length > 1 && (
                    <span className="text-slate-400 font-normal ml-1.5">
                      across {completedJobs.length} files
                    </span>
                  )}
                </p>
                <div className="space-y-2">
                  {mergedCategories.map((cat) => (
                    <div key={cat.name} className="flex items-center justify-between gap-3">
                      <span className="text-sm text-slate-700">{cat.name}</span>
                      <span className="text-xs font-medium text-slate-500 flex-shrink-0">
                        {cat.count} rate{cat.count !== 1 ? 's' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-3">
                <button className="btn-primary flex-1 py-2.5 text-sm">
                  Apply rates
                </button>
                <button
                  onClick={() => setState({ kind: 'idle' })}
                  className="btn-secondary px-4 py-2.5 text-sm"
                >
                  Upload more
                </button>
              </div>
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
