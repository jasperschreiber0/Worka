// ─── Project memory context builder ────────────────────────────────────────
//
// Shared by app/api/chat/route.ts (answering a builder's free-form
// question) and app/api/intake/[fileId]/route.ts (opportunistically
// persisting a project-understanding snapshot right after intake
// completes — see persistProjectUnderstanding below). One computation
// path, not two, so both call sites see identical facts/scope/confidence
// for the same job, and identical observability (see RetrievalMetrics).
//
// Deliberately reuses project_facts / scope_items / clarifying_questions
// (migration 026) rather than a new project_memory table — see CLAUDE.md's
// "Project memory" section for why a second table would just create a
// second, driftable source of truth for the same knowledge.
//
// Selection/ranking/pairing mechanics are NOT reimplemented here —
// selectFactsForPrompt / pairSupersededFacts / inferRelevantCategories /
// MAX_FACTS_IN_PROMPT all live in
// supabase/functions/smooth-responder/pipeline-logic.ts (deliberately
// Deno-global-free so it can be imported from both runtimes — see that
// file's own header comment) and are shared with Stage 3/6's scope/
// estimate reasoning. This file owns query construction (what to fetch,
// under what budgets) and assembly (turning raw rows into a ProjectContext)
// — orchestration, not selection logic.
//
// Query construction is split into pure, exported spec-builder functions
// (buildActiveFactsQuerySpecs / buildSupersededFactsQuerySpec) precisely so
// it's testable without a live database — see lib/project-context.test.ts.
// assembleProjectContext is likewise a pure function over already-fetched
// rows, so the JS-side transformation (ranking, pairing, scope/missing-info
// shaping) is independently testable from the I/O that fetches those rows.

import type { SupabaseClient } from '@supabase/supabase-js'
// Relative, .ts-extensioned import (not the `@/*` alias used elsewhere in
// this codebase) so this file resolves identically under Next.js/webpack
// AND under plain `node --experimental-strip-types` — the latter has no
// concept of tsconfig path aliases, and this file needs to be importable
// by lib/project-context.test.ts (see that file) the same way
// pipeline-logic.ts already is by its own .test.ts. Requires
// allowImportingTsExtensions in tsconfig.json (safe to enable: it only
// widens what's allowed, and noEmit is already true).
import {
  type FactRow,
  selectFactsForPrompt,
  inferRelevantCategories,
  pairSupersededFacts,
  didRelevanceChangeSelection,
  MAX_FACTS_IN_PROMPT,
} from '../supabase/functions/smooth-responder/pipeline-logic.ts'

// Small, separate budget for change history — recency-ordered (unlike
// active facts, where confidence matters more; "what changed most
// recently" is inherently a recency question). Never competes with
// active facts for MAX_FACTS_IN_PROMPT. Also the ordering pairSupersededFacts
// relies on to collapse multi-generation supersession chains — see that
// function's comment in pipeline-logic.ts.
export const SUPERSEDED_HISTORY_LIMIT = 20

// Reserved fetch budget for facts in a category inferRelevantCategories
// flagged as relevant to the builder's question. Sized to match
// MAX_FACTS_IN_PROMPT exactly: if a job has at most this many relevant-
// category facts, ALL of them are fetched and visible to
// selectFactsForPrompt's ranking — none can be excluded by a fetch-level
// cutoff before relevance is even considered, which was the actual defect
// (not "the number was too small" — the number was applied at the wrong
// stage, ranking by confidence before relevance was known at all).
export const RELEVANT_FACTS_FETCH_LIMIT = MAX_FACTS_IN_PROMPT

// Fetch budget for everything NOT in a relevant category, when relevant
// categories were inferred — fills out remaining context/fallback
// material. Also the sole budget used when no relevant categories are
// inferred (preserves the original, simpler single-query behavior
// exactly in that case).
export const OTHER_FACTS_FETCH_LIMIT = 400

// This is a narrower ceiling than before, not an eliminated one: a
// project with more than RELEVANT_FACTS_FETCH_LIMIT facts in a SINGLE
// relevant category could still lose one to a fetch-level cutoff — but
// that's a much smaller, rarer committee (facts sharing one category)
// than "every active fact in the project," which is what the old,
// confidence-only ACTIVE_FACTS_FETCH_LIMIT compared against.
export const ACTIVE_FACTS_FETCH_LIMIT = RELEVANT_FACTS_FETCH_LIMIT + OTHER_FACTS_FETCH_LIMIT

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

// Everything an operator needs to answer "are we approaching retrieval
// limits, and is relevance actually doing anything" without reading code.
// Logged identically by both chat- and intake-triggered context builds,
// since both go through buildProjectContext.
export interface RetrievalMetrics {
  active_fact_count: number
  active_facts_fetched: number
  facts_selected: number
  superseded_fact_count: number
  superseded_selected: number
  retrieval_strategy: 'confidence_only' | 'relevance_partitioned'
  relevance_changed_selection: boolean
  retrieval_duration_ms: number
  pairing_duration_ms: number
  // Per-partition breakdown — null when retrieval_strategy is
  // 'confidence_only' (no partitioning happened). active_facts_fetched
  // above is aggregated across BOTH partitions, which can't tell an
  // operator whether truncation happened in the relevant-category
  // partition (the failure mode that actually matters — see
  // RELEVANT_FACTS_FETCH_LIMIT's comment) or the harmless fallback
  // partition. relevant_facts_limit_reached is a heuristic ("fetched
  // count equals the reserved limit"), not a certainty — the category
  // could have exactly that many facts and nothing was actually lost —
  // but it's the cheap signal available without an extra count query per
  // partition.
  relevant_facts_fetched: number | null
  relevant_facts_limit_reached: boolean
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
  // Superseded by RetrievalMetrics.facts_selected < active_facts_fetched
  // (kept for backward compatibility with any existing caller reading
  // this boolean directly; retrieval carries the actual numbers).
  truncated: boolean
  retrieval: RetrievalMetrics
}

export type ActiveFactRow = FactRow & { source_document_id: string | null }

// ─── Query specs (pure, testable without a live database) ─────────────────

export interface FactQuerySpec {
  superseded: boolean
  categoryIn?: string[]
  categoryNotIn?: string[]
  orderBy: 'confidence' | 'created_at'
  limit: number
}

/**
 * One spec when no relevant categories were inferred (identical to the
 * original single-query behavior — confidence-ordered, ACTIVE_FACTS_FETCH_LIMIT
 * budget, no category partitioning). Two specs when relevant categories
 * exist: a relevant-category query with its own reserved budget, and an
 * "everything else" query with the remaining budget — see
 * RELEVANT_FACTS_FETCH_LIMIT's comment for why this eliminates the
 * fetch-before-relevance ordering bug rather than just enlarging it.
 */
export function buildActiveFactsQuerySpecs(relevantCategories: Set<string>): FactQuerySpec[] {
  if (relevantCategories.size === 0) {
    return [{ superseded: false, orderBy: 'confidence', limit: ACTIVE_FACTS_FETCH_LIMIT }]
  }
  const categories = Array.from(relevantCategories)
  return [
    { superseded: false, categoryIn: categories, orderBy: 'confidence', limit: RELEVANT_FACTS_FETCH_LIMIT },
    { superseded: false, categoryNotIn: categories, orderBy: 'confidence', limit: OTHER_FACTS_FETCH_LIMIT },
  ]
}

export function buildSupersededFactsQuerySpec(): FactQuerySpec {
  // created_at DESC is a hard requirement, not a preference — pairSupersededFacts
  // relies on this exact ordering to collapse multi-generation supersession
  // chains (most-recently-superseded predecessor wins). See that function's
  // comment in pipeline-logic.ts.
  return { superseded: true, orderBy: 'created_at', limit: SUPERSEDED_HISTORY_LIMIT }
}

async function executeFactQuery(sb: SupabaseClient, jobId: string, spec: FactQuerySpec): Promise<FactRow[]> {
  const columns = spec.superseded
    ? 'category, key, value, confidence, embedding'
    // id is required for selectFactsForPrompt's deterministic tiebreak
    // (see pipeline-logic.ts) — only active facts are ever passed to
    // selectFactsForPrompt, so only they need it selected.
    : 'id, category, key, value, confidence, source_document_id, embedding'

  let query = sb.from('project_facts')
    .select(columns)
    .eq('job_id', jobId)
    .eq('superseded', spec.superseded)

  if (spec.categoryIn) query = query.in('category', spec.categoryIn)
  if (spec.categoryNotIn) query = query.not('category', 'in', `(${spec.categoryNotIn.map((c) => `"${c}"`).join(',')})`)

  query = query.order(spec.orderBy, { ascending: false }).limit(spec.limit)

  const { data } = await query
  // `columns` is a runtime string, not a literal, so postgrest-js's
  // template-literal-parsed return type can't be statically inferred here
  // (it resolves to a ParserError type instead of a real row shape) —
  // going through `unknown` first is the correct, minimal fix (and what
  // the compiler itself suggests), not a sign the query is wrong.
  return (data ?? []) as unknown as FactRow[]
}

// ─── Pure assembly (testable without a live database) ──────────────────────

export function assembleProjectContext(
  activeFactRows: ActiveFactRow[],
  supersededFactRows: FactRow[],
  scopeRows: Array<{ trade_category_id: number; included_scope: string[]; excluded_scope: string[]; assumptions: string[] }>,
  questionRows: Array<{ question: string; reason: string }>,
  docs: Array<{ id: string; drawing_title: string | null; document_type: string | null }>,
  relevantCategories: Set<string>,
  counts: {
    activeFactCount: number
    supersededFactCount: number
    relevantFactsFetched?: number | null
    relevantFactsLimit?: number | null
  },
  timings: { retrievalDurationMs: number },
): ProjectContext {
  const docLabel = new Map<string, string>(
    docs.map((d) => [d.id, d.drawing_title ?? d.document_type ?? 'a document'])
  )

  const rankedActive = selectFactsForPrompt(activeFactRows, MAX_FACTS_IN_PROMPT, relevantCategories)
  const truncated = activeFactRows.length > rankedActive.length

  // Only meaningful to compute when relevance was actually applied — with
  // no relevant categories, both selections are definitionally identical.
  const relevanceChangedSelection = relevantCategories.size > 0
    ? didRelevanceChangeSelection(rankedActive, selectFactsForPrompt(activeFactRows, MAX_FACTS_IN_PROMPT))
    : false

  const pairingStartedAt = Date.now()
  const recentChanges = pairSupersededFacts(activeFactRows, supersededFactRows, undefined, SUPERSEDED_HISTORY_LIMIT)
  const pairingDurationMs = Date.now() - pairingStartedAt

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

  const scope = scopeRows.map((s) => ({
    tradeCategoryId: s.trade_category_id,
    included: s.included_scope ?? [],
    excluded: s.excluded_scope ?? [],
    assumptions: s.assumptions ?? [],
  }))

  const missingInformation = questionRows.map((q) => q.question)
  const documentsReferenced = Array.from(new Set(activeFacts.map((f) => f.sourceLabel).filter((l): l is string => Boolean(l))))

  const confidence = activeFacts.length > 0
    ? Math.round(activeFacts.reduce((sum, f) => sum + f.confidence, 0) / activeFacts.length)
    : 0

  const relevantFactsFetched = counts.relevantFactsFetched ?? null
  const relevantFactsLimit = counts.relevantFactsLimit ?? null
  const relevantFactsLimitReached =
    relevantFactsFetched !== null && relevantFactsLimit !== null && relevantFactsFetched >= relevantFactsLimit

  const retrieval: RetrievalMetrics = {
    active_fact_count: counts.activeFactCount,
    active_facts_fetched: activeFactRows.length,
    facts_selected: rankedActive.length,
    superseded_fact_count: counts.supersededFactCount,
    superseded_selected: recentChanges.length,
    retrieval_strategy: relevantCategories.size > 0 ? 'relevance_partitioned' : 'confidence_only',
    relevance_changed_selection: relevanceChangedSelection,
    retrieval_duration_ms: timings.retrievalDurationMs,
    pairing_duration_ms: pairingDurationMs,
    relevant_facts_fetched: relevantFactsFetched,
    relevant_facts_limit_reached: relevantFactsLimitReached,
  }

  return {
    hasData: activeFacts.length > 0 || scope.length > 0,
    activeFacts,
    recentChanges,
    scope,
    missingInformation,
    documentsReferenced,
    confidence,
    truncated,
    retrieval,
  }
}

// ─── Orchestration (I/O — fetches rows, then delegates to assembleProjectContext) ──

export async function buildProjectContext(
  sb: SupabaseClient,
  jobId: string,
  question: string = ''
): Promise<ProjectContext> {
  const relevantCategories = inferRelevantCategories(question)
  const activeSpecs = buildActiveFactsQuerySpecs(relevantCategories)
  const supersededSpec = buildSupersededFactsQuerySpec()

  const retrievalStartedAt = Date.now()
  const [activeResults, supersededRows, scopeResult, questionResult, docsResult, activeCountResult, supersededCountResult] =
    await Promise.all([
      Promise.all(activeSpecs.map((spec) => executeFactQuery(sb, jobId, spec))),
      executeFactQuery(sb, jobId, supersededSpec),
      sb.from('scope_items').select('trade_category_id, included_scope, excluded_scope, assumptions').eq('job_id', jobId),
      sb.from('clarifying_questions').select('question, reason').eq('job_id', jobId).eq('status', 'open'),
      sb.from('project_documents').select('id, drawing_title, document_type').eq('job_id', jobId),
      sb.from('project_facts').select('id', { count: 'exact', head: true }).eq('job_id', jobId).eq('superseded', false),
      sb.from('project_facts').select('id', { count: 'exact', head: true }).eq('job_id', jobId).eq('superseded', true),
    ])
  const retrievalDurationMs = Date.now() - retrievalStartedAt

  // Merge rows from the (1 or 2) active-fact queries — de-duplicated by id,
  // since a fact could in principle satisfy neither category filter's
  // exclusion boundary incorrectly only if the category sets overlap,
  // which they never do by construction (categoryIn / categoryNotIn are
  // built from the same partition), but de-duping defensively costs
  // nothing and removes any doubt.
  const seenIds = new Set<string>()
  const activeFactRows: ActiveFactRow[] = []
  for (const rows of activeResults) {
    for (const row of rows as ActiveFactRow[]) {
      const id = row.id
      if (id && seenIds.has(id)) continue
      if (id) seenIds.add(id)
      activeFactRows.push(row)
    }
  }

  // The relevant-category partition is always activeSpecs[0]/activeResults[0]
  // when partitioning happened (buildActiveFactsQuerySpecs' construction —
  // see that function) — captured here so RetrievalMetrics can report
  // whether THAT specific partition hit its own fetch ceiling, distinct
  // from the aggregated active_facts_fetched/facts_selected numbers which
  // can't tell the two partitions apart.
  const isPartitioned = activeSpecs.length === 2
  const relevantFactsFetched = isPartitioned ? activeResults[0].length : null
  const relevantFactsLimit = isPartitioned ? activeSpecs[0].limit : null

  const context = assembleProjectContext(
    activeFactRows,
    supersededRows,
    (scopeResult.data ?? []) as Array<{ trade_category_id: number; included_scope: string[]; excluded_scope: string[]; assumptions: string[] }>,
    (questionResult.data ?? []) as Array<{ question: string; reason: string }>,
    (docsResult.data ?? []) as Array<{ id: string; drawing_title: string | null; document_type: string | null }>,
    relevantCategories,
    {
      activeFactCount: activeCountResult.count ?? 0,
      supersededFactCount: supersededCountResult.count ?? 0,
      relevantFactsFetched,
      relevantFactsLimit,
    },
    { retrievalDurationMs },
  )

  // Logged here — the one call site both chat and intake share — so
  // "equivalent telemetry on both paths" is true by construction rather
  // than by remembering to duplicate a log statement in two places.
  console.log(JSON.stringify({ event: 'project_context_built', job_id: jobId, ...context.retrieval }))

  return context
}

// ─── Persisted project understanding (outside chat) ────────────────────────
//
// The original product ask included a standing "project confidence /
// completeness / missing information" surface consumable by Job Snapshot
// and Morning Brief — not just answerable on demand in chat. Rather than a
// new subsystem, this persists the same computation buildProjectContext
// already does onto the existing jobs row (migration 035:
// knowledge_confidence / knowledge_missing_count / knowledge_updated_at).
// Called from three places: opportunistically whenever chat answers a
// project_question (via persistContext below, reusing the context it
// already built rather than fetching twice), automatically right after
// intake completes (app/api/intake/[fileId]/route.ts), and opportunistically
// from GET /api/jobs/[jobId]/snapshot when knowledge_updated_at is still
// null (see that route) — a lightweight recovery path for the case a
// transient failure left it null forever with nobody ever asking a chat
// question about that job. No new infrastructure (no cron, no queue): the
// snapshot endpoint is already the most frequently-hit read for exactly
// this job, so piggybacking recovery onto it is the smallest change that
// achieves eventual consistency. Best-effort throughout: a failed write
// here must never break the caller's own flow.
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
