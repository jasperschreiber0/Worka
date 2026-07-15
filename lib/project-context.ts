// ─── Project memory context builder ────────────────────────────────────────
//
// Shared by app/api/chat/route.ts (answering a builder's free-form
// question) and app/api/intake/[fileId]/route.ts (opportunistically
// persisting a project-understanding snapshot right after intake
// completes — see persistProjectUnderstanding below). One computation
// path, not two, so both call sites see identical facts/scope/confidence
// for the same job.
//
// Deliberately reuses project_facts / scope_items / clarifying_questions
// (migration 026) rather than a new project_memory table — see CLAUDE.md's
// "Project memory" section for why a second table would just create a
// second, driftable source of truth for the same knowledge.
//
// Truncation and semantic-duplicate detection are NOT reimplemented here —
// selectFactsForPrompt / pairSupersededFacts / MAX_FACTS_IN_PROMPT /
// inferRelevantCategories all live in
// supabase/functions/smooth-responder/pipeline-logic.ts (deliberately
// Deno-global-free so it can be imported from both runtimes — see that
// file's own header comment) and are shared with Stage 3/6's scope/
// estimate reasoning. A prior version of this file re-declared its own
// truncation logic (recency-ordered, active+superseded mixed in one
// query) that could silently drop an old-but-still-active, high-
// confidence fact out of context — see selectFactsForPrompt's comment for
// the incident.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FactRow,
  selectFactsForPrompt,
  inferRelevantCategories,
  pairSupersededFacts,
  MAX_FACTS_IN_PROMPT,
} from '@/supabase/functions/smooth-responder/pipeline-logic'

// Small, separate budget for change history — recency-ordered (unlike
// active facts, where confidence matters more; "what changed most
// recently" is inherently a recency question). Never competes with
// active facts for MAX_FACTS_IN_PROMPT.
const SUPERSEDED_HISTORY_LIMIT = 20

// Fetched superset for active facts, ordered by confidence — large enough
// that a lower-confidence-but-relevant fact (per inferRelevantCategories)
// still has a real chance to be promoted into the final MAX_FACTS_IN_PROMPT
// selection by selectFactsForPrompt's relevance boost, rather than having
// already been cut by a plain "top 200 by confidence" DB-side limit before
// relevance was ever considered. Bounded, not unbounded — a project with
// more than this many active facts is a documented edge case (see
// `truncated` on ProjectContext), not a silently-wrong answer.
const ACTIVE_FACTS_FETCH_LIMIT = 600

export interface ProjectContextFact {
  category: string
  key: string
  value: string
  confidence: number
  sourceLabel: string | null
}

export interface ProjectContextChange {
  category: string
  key: string
  oldValue: string
  newValue: string
}

export interface ProjectContext {
  hasData: boolean
  activeFacts: ProjectContextFact[]
  // A superseded fact paired with whatever fact replaced it — via exact
  // category+key match, or (reusing the same logic mergeFacts uses at
  // write time) semantic similarity when the replacement used a different
  // category/key label. This pairing *is* the conflict/change record; see
  // pairSupersededFacts in pipeline-logic.ts.
  recentChanges: ProjectContextChange[]
  scope: Array<{ tradeCategoryId: number; included: string[]; excluded: string[]; assumptions: string[] }>
  missingInformation: string[]
  documentsReferenced: string[]
  confidence: number
  // True when this job has more active facts than fit in one prompt, even
  // after ACTIVE_FACTS_FETCH_LIMIT/relevance-boosting — logged so a real
  // instance of this (not yet observed in production data) is visible
  // rather than silently degrading answer quality unnoticed.
  truncated: boolean
}

type ActiveFactRow = FactRow & { source_document_id: string | null }

export async function buildProjectContext(
  sb: SupabaseClient,
  jobId: string,
  question: string = ''
): Promise<ProjectContext> {
  const [{ data: activeRows }, { data: supersededRows }, { data: scopeRows }, { data: questionRows }, { data: docs }] =
    await Promise.all([
      sb.from('project_facts')
        .select('category, key, value, confidence, source_document_id, embedding')
        .eq('job_id', jobId).eq('superseded', false)
        .order('confidence', { ascending: false })
        .limit(ACTIVE_FACTS_FETCH_LIMIT),
      sb.from('project_facts')
        .select('category, key, value, confidence, embedding')
        .eq('job_id', jobId).eq('superseded', true)
        .order('created_at', { ascending: false })
        .limit(SUPERSEDED_HISTORY_LIMIT),
      sb.from('scope_items').select('trade_category_id, included_scope, excluded_scope, assumptions').eq('job_id', jobId),
      sb.from('clarifying_questions').select('question, reason').eq('job_id', jobId).eq('status', 'open'),
      sb.from('project_documents').select('id, drawing_title, document_type').eq('job_id', jobId),
    ])

  const docLabel = new Map<string, string>(
    ((docs ?? []) as Array<{ id: string; drawing_title: string | null; document_type: string | null }>)
      .map((d) => [d.id, d.drawing_title ?? d.document_type ?? 'a document'])
  )

  const activeFactRows = (activeRows ?? []) as ActiveFactRow[]
  const supersededFactRows = (supersededRows ?? []) as FactRow[]

  const relevantCategories = inferRelevantCategories(question)
  const rankedActive = selectFactsForPrompt(activeFactRows, MAX_FACTS_IN_PROMPT, relevantCategories)
  const truncated = activeFactRows.length > rankedActive.length

  const recentChanges = pairSupersededFacts(activeFactRows, supersededFactRows, undefined, SUPERSEDED_HISTORY_LIMIT)

  const activeFacts: ProjectContextFact[] = rankedActive.map((f) => {
    const row = f as ActiveFactRow
    return {
      category: f.category,
      key: f.key,
      value: f.value,
      confidence: f.confidence,
      sourceLabel: row.source_document_id ? docLabel.get(row.source_document_id) ?? null : null,
    }
  })

  const scope = ((scopeRows ?? []) as Array<{ trade_category_id: number; included_scope: string[]; excluded_scope: string[]; assumptions: string[] }>)
    .map((s) => ({ tradeCategoryId: s.trade_category_id, included: s.included_scope ?? [], excluded: s.excluded_scope ?? [], assumptions: s.assumptions ?? [] }))

  const missingInformation = ((questionRows ?? []) as Array<{ question: string; reason: string }>).map((q) => q.question)
  const documentsReferenced = Array.from(new Set(activeFacts.map((f) => f.sourceLabel).filter((l): l is string => Boolean(l))))

  const confidence = activeFacts.length > 0
    ? Math.round(activeFacts.reduce((sum, f) => sum + f.confidence, 0) / activeFacts.length)
    : 0

  return {
    hasData: activeFacts.length > 0 || scope.length > 0,
    activeFacts,
    recentChanges,
    scope,
    missingInformation,
    documentsReferenced,
    confidence,
    truncated,
  }
}

// ─── Persisted project understanding (outside chat) ────────────────────────
//
// The original product ask included a standing "project confidence /
// completeness / missing information" surface consumable by Job Snapshot
// and Morning Brief — not just answerable on demand in chat. Rather than a
// new subsystem, this persists the same computation build ProjectContext
// already does onto the existing jobs row (migration 035:
// knowledge_confidence / knowledge_missing_count / knowledge_updated_at).
// Called from two places: opportunistically whenever chat answers a
// project_question (via persistContext below, reusing the context it
// already built rather than fetching twice), and once automatically right
// after intake completes (app/api/intake/[fileId]/route.ts, alongside the
// existing ensureQuotePriced/runQualityAssurance calls, via
// persistProjectUnderstanding) — so it's populated even if nobody ever
// asks a chat question. Best-effort: a failed write here must never break
// the caller's own flow.
export async function persistContext(sb: SupabaseClient, jobId: string, context: ProjectContext): Promise<void> {
  try {
    await sb.from('jobs').update({
      knowledge_confidence: context.hasData ? context.confidence : null,
      knowledge_missing_count: context.missingInformation.length,
      knowledge_updated_at: new Date().toISOString(),
    }).eq('id', jobId)
  } catch (err) {
    console.error('persistContext: failed to persist project understanding', err)
  }
}

export async function persistProjectUnderstanding(sb: SupabaseClient, jobId: string): Promise<ProjectContext> {
  const context = await buildProjectContext(sb, jobId)
  await persistContext(sb, jobId, context)
  return context
}
