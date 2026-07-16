'use client'

import { useEffect, useRef, useState } from 'react'
import ClarifyingQuestionsPanel, { type ClarifyingQuestion } from './ClarifyingQuestionsPanel'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IntakeProgressProps {
  fileId: string
  jobId: string
  builderId: string
  filename: string
  additionalFileIds?: string[]
  onComplete: (quoteId: string, assumptionCount: number, memoryData?: { similar_projects?: unknown[]; scope_hints?: unknown[]; total_in_memory?: number; skipped_files?: string[]; failed_files?: string[] }) => void
  onError: (message?: string, skippedFiles?: string[], failedFiles?: string[]) => void
  // Present only when the run ended (success or failure) with files that
  // weren't included — lets the error state offer a one-click retry scoped
  // to just those files instead of "start the whole upload over".
  onRetryFiles?: (filenames: string[]) => void
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

interface ClarificationState {
  message: string
  questions: ClarifyingQuestion[]
}

// Per-document extraction checklist — each document now gets its own
// document-worker Edge Function invocation (its own isolated CPU budget)
// instead of sharing one invocation's budget with every other document in
// the upload. This surfaces that per-document status while extraction is
// still in progress, before classification (the existing stage-based
// progress bar below) takes over.
interface DocumentProgressItem {
  document_id: string
  filename: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  error_message?: string | null
}

// ─── Stage display label mapping — mirrors the estimating engine's real
// stages (Document Intelligence -> Project Understanding -> Scope Reasoning ->
// Gap Detection -> Estimate Generation -> QA). ──────────────────────────────

const STAGE_LABELS: Record<string, string> = {
  queued: 'Finishing your last upload first',
  uploading: 'Uploading documents',
  reading: 'Reading documents',
  classifying_documents: 'Classifying documents',
  understanding_project: 'Building project understanding',
  reasoning_scope: 'Reasoning about scope',
  detecting_gaps: 'Checking for missing information',
  generating_estimate: 'Generating the estimate',
  validating: 'Running quality assurance',
  building_quote: 'Building draft quote',
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function IntakeProgress({
  fileId,
  jobId,
  builderId,
  filename,
  additionalFileIds,
  onComplete,
  onError,
  onRetryFiles,
}: IntakeProgressProps) {
  const [progress, setProgress] = useState<ProgressState>({
    stage: 'uploading',
    message: 'Uploading plans...',
    pct: 5,
  })
  const [completedStages, setCompletedStages] = useState<CompletedStage[]>([])
  const [isDone, setIsDone] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [errorSkippedFiles, setErrorSkippedFiles] = useState<string[]>([])
  const [errorFailedFiles, setErrorFailedFiles] = useState<string[]>([])
  const [documentProgress, setDocumentProgress] = useState<DocumentProgressItem[] | null>(null)
  const [clarification, setClarification] = useState<ClarificationState | null>(null)
  const [clarifySubmitting, setClarifySubmitting] = useState(false)
  const [clarifyError, setClarifyError] = useState<string | null>(null)
  const [resumeKey, setResumeKey] = useState(0)
  const [reconnectKey, setReconnectKey] = useState(0)

  const eventSourceRef = useRef<EventSource | null>(null)
  const prevStageRef = useRef<string | null>(null)
  // Vercel kills the connection at a hard 300s ceiling regardless of how long
  // we're willing to poll — the route self-closes safely under that and the
  // browser's EventSource auto-reconnects to the same URL. This timestamp
  // rides along in the URL so the server can track *overall* elapsed time
  // across that whole chain of reconnects, not just the current connection's
  // slice, and still give up if the pipeline is genuinely stuck.
  const startedAtRef = useRef<number>(Date.now())
  // Same idea, but for the last time real progress (a pct change) was
  // observed — lets the server give up on a genuinely-stuck run well before
  // the overall ceiling without punishing a run that's slowly working
  // through several document batches. See shouldGiveUp server-side.
  const lastProgressAtRef = useRef<number>(Date.now())
  const lastProgressPctRef = useRef<number>(5)

  const handleAnswerSubmit = async (answers: Array<{ question_id: string; answer: string }>) => {
    setClarifySubmitting(true)
    setClarifyError(null)
    try {
      const res = await fetch(`/api/intake/${encodeURIComponent(fileId)}/clarify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId, answers }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Could not continue' }))
        throw new Error((body as { error?: string }).error ?? 'Could not continue')
      }
      setClarification(null)
      setResumeKey((k) => k + 1)
    } catch (err) {
      setClarifyError(err instanceof Error ? err.message : 'Could not continue — please try again.')
    } finally {
      setClarifySubmitting(false)
    }
  }

  useEffect(() => {
    const siblings = additionalFileIds && additionalFileIds.length > 0
      ? `&siblings=${encodeURIComponent(additionalFileIds.join(','))}`
      : ''
    // After answering clarifying questions, the /clarify route has already
    // re-triggered the engine (with resume: true) — this reconnect must only
    // poll, not fire a second, non-resumed trigger.
    const resumedParam = resumeKey > 0 ? '&resumed=1' : ''
    const url = `/api/intake/${encodeURIComponent(fileId)}?job_id=${encodeURIComponent(jobId)}&builder_id=${encodeURIComponent(builderId)}${siblings}${resumedParam}&started_at=${startedAtRef.current}&last_progress_at=${lastProgressAtRef.current}`
    const es = new EventSource(url)
    eventSourceRef.current = es
    let settled = false

    const failOnce = (message?: string, skippedFiles?: string[], failedFiles?: string[]) => {
      if (settled) return
      settled = true
      setHasError(true)
      if (message) setErrorMessage(message)
      if (skippedFiles) setErrorSkippedFiles(skippedFiles)
      if (failedFiles) setErrorFailedFiles(failedFiles)
      es.close()
      onError(message, skippedFiles, failedFiles)
    }

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

        if (data.pct !== lastProgressPctRef.current) {
          lastProgressPctRef.current = data.pct
          lastProgressAtRef.current = Date.now()
        }

        setProgress(data)
      } catch {
        // Ignore parse errors in progress events
      }
    })

    es.addEventListener('document_progress', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { documents: DocumentProgressItem[] }
        setDocumentProgress(data.documents)
        // Per-document extraction (the document-worker queue phase) doesn't
        // change files.intake_stage/pct at all — those only start moving
        // once classification takes over — so the 'progress' handler above
        // never fires here and lastProgressAtRef was previously frozen at
        // whatever it was when this component mounted for the entire
        // duration of document processing. That meant the "last_progress_at"
        // this ref seeds into the next SSE reconnect's URL (every ~260s, see
        // the effect below) was stale by construction, not just possibly
        // stale — the server's shouldGiveUp check would see a large, ever-
        // growing gap on every reconnect during this phase and could give up
        // on a run that was, in fact, still genuinely progressing one
        // document at a time. A per-document status snapshot changing IS
        // real progress — treat it as such.
        lastProgressAtRef.current = Date.now()
      } catch {
        // Ignore parse errors — the stage-based progress bar below still
        // reflects overall progress even if this per-document detail is lost.
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
          similar_projects?: unknown[]
          scope_hints?: unknown[]
          total_in_memory?: number
          skipped_files?: string[]
          failed_files?: string[]
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
          onComplete(data.quote_id, data.assumption_count, {
            similar_projects: data.similar_projects,
            scope_hints: data.scope_hints,
            total_in_memory: data.total_in_memory,
            skipped_files: data.skipped_files,
            failed_files: data.failed_files,
          })
        }, 1000)
      } catch {
        failOnce()
      }
    })

    // Stage 4/5 — the engine found a blocking gap. Pause here instead of
    // failing; the builder answers, and we reconnect (resumeKey bump below).
    es.addEventListener('needs_clarification', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as ClarificationState
        settled = true
        es.close()
        setClarification(data)
      } catch {
        failOnce()
      }
    })

    // Server emits this and closes cleanly when it's approaching Vercel's
    // hard 300s connection ceiling, rather than waiting to be killed — not
    // a failure. Mark settled so the native 'error' event this same close
    // triggers (EventSource can't distinguish a deliberate close from a
    // real connection loss) is a no-op on this closure, then open a fresh
    // connection via the same reconnect-safe trigger check server-side.
    es.addEventListener('reconnect', () => {
      settled = true
      es.close()
      setReconnectKey((k) => k + 1)
    })

    // Handles both server-emitted `event: error` (has .data) and
    // EventSource connection failures (no .data). skipped_files/failed_files
    // are now populated on timeout/failure too, not just on success — see
    // the early-persistence fix in smooth-responder/index.ts.
    es.addEventListener('error', (e: Event) => {
      let message: string | undefined
      let skippedFiles: string[] | undefined
      let failedFiles: string[] | undefined
      const data = (e as MessageEvent).data as string | undefined
      if (data) {
        try {
          const parsed = JSON.parse(data) as { message?: string; skipped_files?: string[]; failed_files?: string[] }
          message = parsed.message
          skippedFiles = parsed.skipped_files
          failedFiles = parsed.failed_files
        } catch { /* ignore */ }
      }
      failOnce(message, skippedFiles, failedFiles)
    })

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return
      failOnce()
    }

    return () => {
      settled = true
      es.close()
    }
  }, [fileId, jobId, builderId, onComplete, onError, resumeKey, reconnectKey])

  // ── Clarifying questions state (Stage 4/5) ─────────────────────────────────
  if (clarification) {
    return (
      <ClarifyingQuestionsPanel
        message={clarification.message}
        questions={clarification.questions}
        submitting={clarifySubmitting}
        error={clarifyError}
        onSubmit={handleAnswerSubmit}
      />
    )
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (hasError) {
    const missedFiles = [...errorSkippedFiles, ...errorFailedFiles]
    const totalFiles = 1 + (additionalFileIds?.length ?? 0)
    const processedCount = Math.max(0, totalFiles - missedFiles.length)
    return (
      <div className="rounded-xl border border-[rgba(244,67,54,0.3)] bg-[rgba(244,67,54,0.08)] px-4 py-5 space-y-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-[rgba(244,67,54,0.15)] flex items-center justify-center flex-shrink-0">
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
          <p className="text-sm font-semibold text-[#f44336]">Processing failed</p>
        </div>
        <p className="text-sm text-[#f44336] pl-10">
          {errorMessage ?? <>Could not process <span className="font-medium">{filename}</span>. Please try again.</>}
        </p>
        {missedFiles.length > 0 && (
          <div className="pl-10 space-y-2">
            <p className="text-sm text-[#f44336]">
              {totalFiles > 1
                ? `${processedCount} of ${totalFiles} files processed. The following ${missedFiles.length === 1 ? 'file was' : 'files were'} not included due to processing limits:`
                : `This file was not included due to processing limits:`}
            </p>
            <ul className="text-sm text-[#f44336]/90 list-disc list-inside space-y-0.5">
              {missedFiles.map((f) => <li key={f}>{f}</li>)}
            </ul>
            {onRetryFiles && (
              <button
                type="button"
                onClick={() => onRetryFiles(missedFiles)}
                className="mt-1 text-sm font-semibold text-[#ff6b2b] hover:underline"
              >
                Retry {missedFiles.length === 1 ? 'this file' : `these ${missedFiles.length} files`} only →
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  // ── Main progress UI ───────────────────────────────────────────────────────
  return (
    <div className="rounded-xl border border-[#2e2e2e] bg-[#222222] px-4 py-5 space-y-4">
      {/* File name row */}
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-md bg-[rgba(255,107,43,0.13)] border border-[rgba(255,107,43,0.2)] flex items-center justify-center flex-shrink-0">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="text-[#ff6b2b]"
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
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-[#e0e0e0] truncate">{filename}</p>
          {additionalFileIds && additionalFileIds.length > 0 && (
            <p className="text-[11px] text-[#555555] mt-0.5">+ {additionalFileIds.length} more file{additionalFileIds.length !== 1 ? 's' : ''}</p>
          )}
        </div>
      </div>

      {/* Per-document extraction checklist */}
      {documentProgress && documentProgress.length > 1 && (
        <ul className="space-y-1.5" aria-label="Document processing status">
          {documentProgress.map((doc) => (
            <li key={doc.document_id} className="flex items-center gap-2 text-[12px]">
              {doc.status === 'completed' && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="flex-shrink-0">
                  <path d="M2 6l2.5 2.5L10 3" stroke="#4caf50" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {doc.status === 'failed' && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="flex-shrink-0">
                  <path d="M3 3l6 6M9 3l-6 6" stroke="#f44336" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              )}
              {doc.status === 'running' && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="flex-shrink-0 animate-spin">
                  <path d="M6 1v2M6 9v2M1 6h2M9 6h2" stroke="#ff6b2b" strokeWidth="1.25" strokeLinecap="round" />
                </svg>
              )}
              {doc.status === 'pending' && (
                <span className="w-3 h-3 rounded-full border border-[#555555] flex-shrink-0" aria-hidden="true" />
              )}
              <span
                className={
                  doc.status === 'completed' ? 'text-[#4caf50]'
                    : doc.status === 'failed' ? 'text-[#f44336]'
                    : doc.status === 'running' ? 'text-[#ff6b2b] font-medium'
                    : 'text-[#555555]'
                }
              >
                {doc.filename}
                {doc.status === 'running' && ' — processing'}
                {doc.status === 'failed' && ' — needs review'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="h-2 w-full rounded-full bg-[#2a2a2a] overflow-hidden">
          <div
            className="h-full rounded-full bg-[#ff6b2b] transition-all duration-500"
            style={{ width: `${progress.pct}%` }}
            role="progressbar"
            aria-valuenow={progress.pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Intake progress"
          />
        </div>
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-[#555555] font-medium">{progress.pct}%</p>
        </div>
      </div>

      {/* Current stage message */}
      {!isDone ? (
        <p className="text-[13px] font-semibold text-[#ff6b2b]">{progress.message}</p>
      ) : (
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-[rgba(76,175,80,0.15)] flex items-center justify-center flex-shrink-0">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path
                d="M1.5 5L3.75 7.5L8.5 2.5"
                stroke="#4caf50"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <p className="text-[13px] font-semibold text-[#4caf50]">{progress.message}</p>
        </div>
      )}

      {/* Completed stages list */}
      {completedStages.length > 0 && (
        <ul className="space-y-1" aria-label="Completed stages">
          {completedStages.map((s) => (
            <li
              key={s.stage}
              className="flex items-center gap-2 text-[12px] text-[#555555] animate-fade-in"
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
                  stroke="#4caf50"
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
            <li className="flex items-center gap-2 text-sm font-semibold text-[#ff6b2b]">
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
