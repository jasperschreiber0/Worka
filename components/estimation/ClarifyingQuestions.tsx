'use client'
import React, { useMemo, useState } from 'react'
import {
  OPEN_QUESTION_GROUP_LABEL,
  ESSENTIAL_QUESTION_GROUPS,
  type OpenQuestionGroup,
  type ClarificationStatus,
} from '@/lib/estimation-reasoning'

// ─── ClarifyingQuestions ──────────────────────────────────────────────────────
// The Stage 2 step: answer the essential open questions inline, or skip straight
// to an indicative estimate. Skipping (or leaving essential gaps) keeps every
// output watermarked "Indicative / Budget-Range Only".

export interface QuestionItem {
  id: string
  group: OpenQuestionGroup
  question: string
  source_reference: string | null
  resolved: boolean
  answer: string | null
}

interface Props {
  jobId: string | null
  questions: QuestionItem[]
  status: ClarificationStatus
  onDecision: (next: { is_indicative: boolean; clarification_status: ClarificationStatus }) => void
}

const GROUP_ORDER: OpenQuestionGroup[] = [
  'missing_documents',
  'unselected_finishes',
  'drawing_annotations',
  'commercial',
  'output',
]

export default function ClarifyingQuestions({ jobId, questions, status, onDecision }: Props) {
  // Local draft + resolved state, seeded from props.
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, q.answer ?? '']))
  )
  const [resolved, setResolved] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, q.resolved]))
  )
  const [savingId, setSavingId] = useState<string | null>(null)
  const [deciding, setDeciding] = useState(false)
  const [localStatus, setLocalStatus] = useState<ClarificationStatus>(status)
  const [error, setError] = useState<string | null>(null)

  const resolvedCount = useMemo(() => Object.values(resolved).filter(Boolean).length, [resolved])
  const essentialOpen = useMemo(
    () => questions.filter((q) => ESSENTIAL_QUESTION_GROUPS.includes(q.group) && !resolved[q.id]).length,
    [questions, resolved]
  )

  // Typed array (not a Map) — the repo target has downlevel iteration disabled.
  // Annotate the variable (not just useMemo's generic) so it stays typed even
  // where @types/react isn't installed and useMemo resolves to any.
  const grouped: Array<{ group: OpenQuestionGroup; items: QuestionItem[] }> = useMemo(
    () =>
      GROUP_ORDER.map((group) => ({ group, items: questions.filter((q) => q.group === group) })).filter(
        (g) => g.items.length > 0
      ),
    [questions]
  )

  async function saveAnswer(q: QuestionItem) {
    const answer = (drafts[q.id] ?? '').trim()
    setSavingId(q.id)
    setError(null)
    try {
      const res = await fetch('/api/estimation/questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'answer', job_id: jobId, question_id: q.id, answer }),
      })
      if (!res.ok) throw new Error('save failed')
      setResolved((r: Record<string, boolean>) => ({ ...r, [q.id]: answer.length > 0 }))
    } catch {
      setError('Could not save that answer. Please try again.')
    } finally {
      setSavingId(null)
    }
  }

  async function decide(action: 'skip' | 'complete') {
    setDeciding(true)
    setError(null)
    try {
      const res = await fetch('/api/estimation/questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, job_id: jobId }),
      })
      const data = (await res.json()) as { is_indicative?: boolean; clarification_status?: ClarificationStatus; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'failed')
      const nextStatus = data.clarification_status ?? (action === 'skip' ? 'skipped' : 'answered')
      setLocalStatus(nextStatus)
      onDecision({ is_indicative: data.is_indicative ?? true, clarification_status: nextStatus })
    } catch {
      setError('Could not update. Please try again.')
    } finally {
      setDeciding(false)
    }
  }

  const card: React.CSSProperties = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--bg-border)',
    borderRadius: 16,
    padding: 20,
  }

  return (
    <section style={card}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
          Before pricing — essential questions
        </p>
        <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
          {resolvedCount} of {questions.length} answered
        </span>
      </div>
      <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Answer what you can — these materially move the number. Or skip to an indicative, budget-range estimate and
        resolve them later.
      </p>

      {localStatus !== 'pending' && (
        <div
          className="rounded-xl px-4 py-2.5 mb-4 text-sm"
          style={{
            background: localStatus === 'skipped' ? 'rgba(255,152,0,0.1)' : 'rgba(76,175,80,0.12)',
            color: localStatus === 'skipped' ? 'var(--status-amber)' : 'var(--status-green)',
            border: `1px solid ${localStatus === 'skipped' ? 'var(--status-amber)' : 'var(--status-green)'}`,
          }}
        >
          {localStatus === 'skipped'
            ? 'Skipped — the estimate will be labelled Indicative / Budget-Range Only.'
            : 'Recorded. The estimate will use your answers where given.'}
        </div>
      )}

      <div className="grid gap-5">
        {grouped.map(({ group, items }) => (
          <div key={group}>
            <div className="flex items-center gap-2 mb-2">
              <p className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                {OPEN_QUESTION_GROUP_LABEL[group]}
              </p>
              {ESSENTIAL_QUESTION_GROUPS.includes(group) && (
                <span
                  className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase"
                  style={{ background: 'var(--orange-subtle)', color: 'var(--orange-primary)' }}
                >
                  Cost-critical
                </span>
              )}
            </div>
            <div className="grid gap-2">
              {items.map((q) => (
                <QuestionRow
                  key={q.id}
                  q={q}
                  draft={drafts[q.id] ?? ''}
                  resolved={Boolean(resolved[q.id])}
                  saving={savingId === q.id}
                  onChange={(v) => setDrafts((d: Record<string, string>) => ({ ...d, [q.id]: v }))}
                  onSave={() => saveAnswer(q)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <p className="mt-3 text-xs rounded-lg px-3 py-2" style={{ color: 'var(--status-amber)', background: 'rgba(255,152,0,0.1)' }}>
          {error}
        </p>
      )}

      {/* Progress + actions */}
      <div className="mt-5 pt-4" style={{ borderTop: '1px solid var(--bg-border)' }}>
        {essentialOpen > 0 && (
          <p className="text-xs mb-3" style={{ color: 'var(--text-tertiary)' }}>
            {essentialOpen} cost-critical question{essentialOpen !== 1 ? 's' : ''} still open — the estimate stays
            budget-range until these are resolved.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => decide('complete')}
            disabled={deciding}
            className="text-sm font-semibold rounded-xl px-5 py-2.5 transition-opacity disabled:opacity-50"
            style={{ color: '#fff', background: 'var(--orange-primary)' }}
          >
            {deciding ? 'Saving…' : 'Continue to estimate'}
          </button>
          <button
            onClick={() => decide('skip')}
            disabled={deciding}
            className="text-sm font-medium rounded-xl px-5 py-2.5 transition-opacity disabled:opacity-50"
            style={{ color: 'var(--text-secondary)', background: 'var(--bg-elevated)', border: '1px solid var(--bg-border)' }}
          >
            Skip to indicative estimate
          </button>
        </div>
      </div>
    </section>
  )
}

// ── question row ─────────────────────────────────────────────────────────────

function QuestionRow({
  q,
  draft,
  resolved,
  saving,
  onChange,
  onSave,
}: {
  q: QuestionItem
  draft: string
  resolved: boolean
  saving: boolean
  onChange: (v: string) => void
  onSave: () => void
  key?: React.Key
}) {
  const dirty = draft.trim() !== (q.answer ?? '').trim()
  return (
    <div
      className="rounded-xl px-3.5 py-3"
      style={{
        background: 'var(--bg-elevated)',
        border: resolved ? '1px solid var(--status-green)' : '1px solid transparent',
      }}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="flex-shrink-0 flex items-center justify-center rounded-full"
          style={{
            width: 18,
            height: 18,
            marginTop: 1,
            background: resolved ? 'var(--status-green)' : 'transparent',
            border: resolved ? 'none' : '1.5px solid var(--bg-border)',
          }}
        >
          {resolved && (
            <svg style={{ width: 11, height: 11, color: '#fff' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm" style={{ color: 'var(--text-primary)', lineHeight: 1.45 }}>{q.question}</p>
          {q.source_reference && (
            <span
              className="inline-block text-[10px] px-1.5 py-0.5 rounded mt-1"
              style={{ background: 'rgba(33,150,243,0.08)', color: 'var(--status-blue)', border: '0.5px solid rgba(33,150,243,0.2)' }}
            >
              {q.source_reference}
            </span>
          )}
          <div className="flex items-end gap-2 mt-2">
            <textarea
              value={draft}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
              rows={1}
              placeholder="Your answer, or leave blank"
              className="flex-1 text-sm rounded-lg px-3 py-2 resize-y"
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)', minHeight: 38 }}
            />
            <button
              onClick={onSave}
              disabled={saving || (!dirty && resolved)}
              className="text-xs font-semibold rounded-lg px-3 py-2 transition-opacity disabled:opacity-40 flex-shrink-0"
              style={{ color: 'var(--orange-primary)', background: 'var(--orange-subtle)' }}
            >
              {saving ? 'Saving…' : resolved && !dirty ? 'Saved' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
