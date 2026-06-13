'use client'

import { useEffect, useRef, useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IntakeProgressProps {
  fileId: string
  jobId: string
  builderId: string
  filename: string
  onComplete: (quoteId: string, assumptionCount: number) => void
  onError: () => void
}

interface ProgressState {
  stage: string
  message: string
  pct: number
}

interface CompletedStage {
  stage: string
  message: string
}

// ─── Stage display label mapping ──────────────────────────────────────────────

const STAGE_LABELS: Record<string, string> = {
  uploading: 'Uploading plans',
  reading: 'Reading file',
  analysing: 'Analysing with AI',
  extracting_site: 'Site works & concrete',
  extracting_framing: 'Framing quantities',
  extracting_roofing: 'Roofing',
  extracting_fitout: 'Fit-out & finishes',
  extracting_electrical: 'Electrical & prelims',
  validating: 'Quantity validation',
  building_quote: 'Building draft quote',
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function IntakeProgress({
  fileId,
  jobId,
  builderId,
  filename,
  onComplete,
  onError,
}: IntakeProgressProps) {
  const [progress, setProgress] = useState<ProgressState>({
    stage: 'uploading',
    message: 'Uploading plans...',
    pct: 5,
  })
  const [completedStages, setCompletedStages] = useState<CompletedStage[]>([])
  const [isDone, setIsDone] = useState(false)
  const [hasError, setHasError] = useState(false)

  const eventSourceRef = useRef<EventSource | null>(null)
  const prevStageRef = useRef<string | null>(null)

  useEffect(() => {
    const url = `/api/intake/${encodeURIComponent(fileId)}?job_id=${encodeURIComponent(jobId)}&builder_id=${encodeURIComponent(builderId)}`
    const es = new EventSource(url)
    eventSourceRef.current = es
    let settled = false

    es.addEventListener('progress', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as ProgressState

        // Move previous stage to completed list
        if (prevStageRef.current && prevStageRef.current !== data.stage) {
          const label = STAGE_LABELS[prevStageRef.current]
          if (label) {
            setCompletedStages((prev) => [
              ...prev,
              { stage: prevStageRef.current!, message: label },
            ])
          }
        }
        prevStageRef.current = data.stage

        setProgress(data)
      } catch {
        // Ignore parse errors in progress events
      }
    })

    es.addEventListener('complete', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as {
          stage: string
          message: string
          pct: number
          quote_id: string
          assumption_count: number
        }

        // Move last active stage to completed
        if (prevStageRef.current) {
          const label = STAGE_LABELS[prevStageRef.current]
          if (label) {
            setCompletedStages((prev) => [
              ...prev,
              { stage: prevStageRef.current!, message: label },
            ])
          }
        }

        setProgress({ stage: 'complete', message: data.message, pct: 100 })
        setIsDone(true)
        settled = true
        es.close()

        setTimeout(() => {
          onComplete(data.quote_id, data.assumption_count)
        }, 1000)
      } catch {
        if (settled) return
        settled = true
        setHasError(true)
        es.close()
        onError()
      }
    })

    es.addEventListener('error', () => {
      if (settled) return
      settled = true
      setHasError(true)
      es.close()
      onError()
    })

    es.onerror = () => {
      if (settled || es.readyState === EventSource.CLOSED) return
      settled = true
      setHasError(true)
      es.close()
      onError()
    }

    return () => {
      es.close()
    }
  }, [fileId, jobId, builderId, onComplete, onError])

  // ── Error state ────────────────────────────────────────────────────────────
  if (hasError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-5 space-y-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 5v3M8 11h.01M14 8A6 6 0 112 8a6 6 0 0112 0z"
                stroke="#ef4444"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <p className="text-sm font-semibold text-red-700">Processing failed</p>
        </div>
        <p className="text-sm text-red-600 pl-10">
          Could not process <span className="font-medium">{filename}</span>. Please try again.
        </p>
      </div>
    )
  }

  // ── Main progress UI ───────────────────────────────────────────────────────
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-5 space-y-4">
      {/* File name row */}
      <div className="flex items-center gap-2.5">
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
        <p className="text-sm font-medium text-slate-800 truncate min-w-0">{filename}</p>
      </div>

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full rounded-full bg-brand-500 transition-all duration-500"
            style={{ width: `${progress.pct}%` }}
            role="progressbar"
            aria-valuenow={progress.pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Intake progress"
          />
        </div>
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500 font-medium">{progress.pct}%</p>
        </div>
      </div>

      {/* Current stage message */}
      {!isDone ? (
        <p className="text-sm font-semibold text-brand-600">{progress.message}</p>
      ) : (
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path
                d="M1.5 5L3.75 7.5L8.5 2.5"
                stroke="#16a34a"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <p className="text-sm font-semibold text-green-700">{progress.message}</p>
        </div>
      )}

      {/* Completed stages list */}
      {completedStages.length > 0 && (
        <ul className="space-y-1" aria-label="Completed stages">
          {completedStages.map((s) => (
            <li
              key={s.stage}
              className="flex items-center gap-2 text-sm text-slate-500 animate-fade-in"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
                className="flex-shrink-0"
              >
                <path
                  d="M2 6l2.5 2.5L10 3"
                  stroke="#6366f1"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>{s.message}</span>
            </li>
          ))}

          {/* Active stage indicator */}
          {!isDone && (
            <li className="flex items-center gap-2 text-sm font-semibold text-brand-500">
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
                className="flex-shrink-0"
              >
                <path
                  d="M6 1v2M6 9v2M1 6h2M9 6h2M2.636 2.636l1.414 1.414M7.95 7.95l1.414 1.414M2.636 9.364l1.414-1.414M7.95 4.05l1.414-1.414"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                />
              </svg>
              <span>{STAGE_LABELS[progress.stage] ?? progress.stage}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
