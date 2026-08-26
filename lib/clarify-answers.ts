// Pure decision logic for POST /api/intake/[fileId]/clarify's per-answer
// project_facts persistence (reliability audit finding #1, project_facts
// insert). Extracted so the "never resume with an unpersisted answer"
// invariant is unit-testable without a live database — the route itself
// owns all the Supabase I/O.

export interface ClarifyAnswerOutcome {
  questionId: string
  /** true if the fact was inserted successfully, or an identical fact already existed (retry). */
  factPersisted: boolean
}

/**
 * The estimating engine must only be resumed once every answer that had a
 * matching clarifying_questions row also has its project_facts row
 * confirmed persisted. An empty outcomes array (no answer in the request
 * matched a real clarifying_questions row — e.g. bad/stale question_ids)
 * is vacuously true: that case attempted no persistence at all, so it
 * carries the same "resume anyway" behavior this route already had before
 * this fix, unrelated to the failure this fix closes.
 */
export function shouldResumeAfterClarify(outcomes: ClarifyAnswerOutcome[]): boolean {
  return outcomes.every((o) => o.factPersisted)
}

export function failedQuestionIds(outcomes: ClarifyAnswerOutcome[]): string[] {
  return outcomes.filter((o) => !o.factPersisted).map((o) => o.questionId)
}

/**
 * Duplicate-persistence guard for a retried clarify submission. project_facts
 * has no unique constraint on (job_id, category, key) — by design, since a
 * document-derived fact legitimately gets superseded rather than uniqued —
 * so a retry of an already-successful insert (the client never saw the
 * success response, or resubmitted the same batch) would otherwise create a
 * second identical builder_answer fact. Mirrors mergeFacts' own
 * exact-restatement dedup used elsewhere in this pipeline (same-value
 * duplicates are skipped, not re-inserted), applied here at the one call
 * site outside that merge pipeline that also writes project_facts directly.
 */
export function isDuplicateBuilderAnswerFact(
  existing: { category: string; key: string; value: string; superseded: boolean } | null,
  candidate: { category: string; key: string; value: string }
): boolean {
  if (!existing || existing.superseded) return false
  return existing.category === candidate.category && existing.key === candidate.key && existing.value === candidate.value
}
