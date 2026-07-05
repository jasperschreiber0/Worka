'use client'
import React, { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import ProjectAssessmentCard from '@/components/estimation/ProjectAssessmentCard'
import ClarifyingQuestions, { type QuestionItem } from '@/components/estimation/ClarifyingQuestions'
import IndicativeBanner from '@/components/estimation/IndicativeBanner'
import type { ProjectAssessment, ClarificationStatus } from '@/lib/estimation-reasoning'

// ─── Project assessment page ──────────────────────────────────────────────────
// The reason-first stage (Stage 1) + the clarifying-questions step (Stage 2).
// In demo mode this shows the 16 Alfred St worked example; with ?job_id= it loads
// a stored assessment. When indicative, a visible budget-range banner sits on top.

interface QuestionState {
  questions: QuestionItem[]
  clarification_status: ClarificationStatus
  is_indicative: boolean
}

function AssessmentView() {
  const searchParams = useSearchParams()
  const jobId = searchParams.get('job_id')

  const [assessment, setAssessment] = useState<ProjectAssessment | null>(null)
  const [questionState, setQuestionState] = useState<QuestionState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const qs = jobId ? `?job_id=${encodeURIComponent(jobId)}` : ''
        const [assessRes, questionsRes] = await Promise.all([
          fetch(`/api/estimation/assess${qs}`),
          fetch(`/api/estimation/questions${qs}`),
        ])
        const assessData = (await assessRes.json()) as { assessment?: ProjectAssessment | null; error?: string }
        if (cancelled) return
        if (!assessRes.ok) {
          setError(assessData.error ?? 'Could not load the assessment.')
          return
        }
        setAssessment(assessData.assessment ?? null)

        if (questionsRes.ok) {
          const qData = (await questionsRes.json()) as QuestionState
          if (!cancelled) setQuestionState(qData)
        }
      } catch {
        if (!cancelled) setError('Could not load the assessment.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [jobId])

  const isIndicative = questionState?.is_indicative ?? true

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-shell)' }}>
      <header style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--bg-border)' }}>
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link href="/chat" className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Chat
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Project assessment</h1>
          <p className="mt-1.5" style={{ color: 'var(--text-secondary)' }}>
            Reason first, price later. WorkA classifies every document, flags what it can&rsquo;t read, and sets out the
            scope, complexity and the questions that must be answered — before a single number is put to it.
          </p>
        </div>

        {loading && (
          <div className="rounded-2xl p-8 text-center" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)' }}>
            <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Reading the documents…</p>
          </div>
        )}

        {!loading && error && (
          <div className="rounded-2xl p-5" style={{ background: 'rgba(255,152,0,0.1)', border: '1px solid rgba(255,152,0,0.2)' }}>
            <p className="text-sm" style={{ color: 'var(--status-amber)' }}>{error}</p>
          </div>
        )}

        {!loading && !error && !assessment && (
          <div className="rounded-2xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)' }}>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              No assessment yet for this job. Upload the project documents to generate one.
            </p>
          </div>
        )}

        {!loading && !error && assessment && (
          <div className="grid gap-4">
            {isIndicative && (
              <IndicativeBanner reason={assessment.scope.estimate_type_justification} />
            )}

            <ProjectAssessmentCard assessment={assessment} showOpenQuestions={!questionState} />

            {questionState && questionState.questions.length > 0 && (
              <ClarifyingQuestions
                jobId={jobId}
                questions={questionState.questions}
                status={questionState.clarification_status}
                onDecision={({ is_indicative, clarification_status }) =>
                  setQuestionState((s: QuestionState | null) => (s ? { ...s, is_indicative, clarification_status } : s))
                }
              />
            )}
          </div>
        )}
      </main>
    </div>
  )
}

export default function AssessmentPage() {
  return (
    <Suspense fallback={null}>
      <AssessmentView />
    </Suspense>
  )
}
