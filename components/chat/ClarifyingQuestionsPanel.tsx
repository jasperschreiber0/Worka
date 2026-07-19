'use client'

import { useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClarifyingQuestion {
  id: string
  question: string
  reason: string
}

export interface ClarifyingQuestionsPanelProps {
  message: string
  questions: ClarifyingQuestion[]
  submitting: boolean
  error: string | null
  // A transient, expected condition (another upload for this job still
  // finishing) being retried automatically — distinct from `error`, which
  // is a terminal failure the builder needs to act on. Rendered as an
  // informative, non-alarming status line rather than a red error, so the
  // builder understands the system is actively working, not stuck.
  retryStatus?: string | null
  onSubmit: (answers: Array<{ question_id: string; answer: string }>) => void
}

// ─── Component ────────────────────────────────────────────────────────────────
// Stage 4/5 — Gap Detection surfaced blocking questions. Pure presentation:
// collects the builder's answers and hands them back up. No business logic —
// the estimating engine decides what counts as "blocking" and how answers
// change the estimate.

export default function ClarifyingQuestionsPanel({
  message,
  questions,
  submitting,
  error,
  retryStatus,
  onSubmit,
}: ClarifyingQuestionsPanelProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({})

  const allAnswered = questions.every((q) => (answers[q.id] ?? '').trim().length > 0)

  const handleSubmit = () => {
    if (!allAnswered || submitting) return
    onSubmit(questions.map((q) => ({ question_id: q.id, answer: answers[q.id].trim() })))
  }

  return (
    <div className="rounded-xl border border-[rgba(255,152,0,0.3)] bg-[rgba(255,152,0,0.06)] px-4 py-5 space-y-4">
      <div className="flex items-start gap-2.5">
        <div className="w-8 h-8 rounded-md bg-[rgba(255,152,0,0.15)] border border-[rgba(255,152,0,0.25)] flex items-center justify-center flex-shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="text-[#ff9800]">
            <path
              d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01M12 21a9 9 0 100-18 9 9 0 000 18z"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-[#ff9800]">Before I estimate this job</p>
          <p className="text-xs mt-0.5 text-[#a0a0a0] leading-snug">{message}</p>
        </div>
      </div>

      <div className="space-y-3">
        {questions.map((q, idx) => (
          <div key={q.id} className="rounded-lg border border-[#2e2e2e] bg-[#1c1c1c] px-3.5 py-3 space-y-2">
            <div>
              <p className="text-[13px] font-medium text-[#e0e0e0]">
                {idx + 1}. {q.question}
              </p>
              <p className="text-[11px] text-[#666666] mt-0.5">{q.reason}</p>
            </div>
            <textarea
              value={answers[q.id] ?? ''}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
              placeholder="Your answer..."
              rows={2}
              disabled={submitting}
              className="w-full text-[13px] rounded-md px-2.5 py-2 resize-none bg-[#222222] border border-[#333333] text-[#e0e0e0] placeholder:text-[#555555] focus:outline-none focus:border-[#ff6b2b]"
            />
          </div>
        ))}
      </div>

      {retryStatus && (
        <div className="flex items-center gap-2 text-xs text-[#ff9800]">
          <svg className="animate-spin flex-shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
            <path d="M22 12a10 10 0 00-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
          <span>{retryStatus}</span>
        </div>
      )}
      {error && <p className="text-xs text-[#f44336]">{error}</p>}

      <button
        onClick={handleSubmit}
        disabled={!allAnswered || submitting}
        className="w-full btn-primary py-2.5 text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
      >
        {submitting ? 'Continuing...' : 'Continue estimating'}
      </button>
    </div>
  )
}
