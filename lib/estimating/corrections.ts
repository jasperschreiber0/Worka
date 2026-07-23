// ─── Learning-engine retrieval (estimator rebuild, Phase 2) ────────────────
// Finds past builder corrections (estimator_corrections, migration 069) on
// projects comparable to the one currently being estimated, for a specific
// trade. Reuses scoreProject (lib/estimation-engine.ts) — the exact
// similarity scorer already powering "similar historical projects" —
// rather than building a second one: job type +30, floor area +15-20,
// region +15, finish level +15, wet areas +10, storeys +10.
//
// Pure function: the caller is responsible for the join (estimator_
// corrections -> jobs -> project_memory) that produces each candidate's
// job_metadata. Not wired into any live Claude call yet — there is no
// trade-agent to feed it. See migration 069's header comment for why.

// Relative, .ts-extensioned imports (not the `@/*` alias used elsewhere in
// this codebase) so this file resolves identically under Next.js/webpack
// AND under plain `node --experimental-strip-types` — see
// lib/project-context.ts's identical comment for why. scoreProject's own
// only import is `import type`, which strips to nothing at runtime, so the
// whole chain is safe for a dependency-free unit test.
import { scoreProject } from '../estimation-engine.ts'
import type { ProjectMetadata, SimilarProject } from '../types/estimation.types.ts'

// Mirrors project_memory's own "worth surfacing" floor (see
// GET/POST /api/estimation/similar-jobs) — a correction from a barely-related
// project is noise, not a pattern.
export const CORRECTION_MIN_SIMILARITY = 50
export const CORRECTION_DEFAULT_LIMIT = 5

export interface CorrectionCandidate {
  id: string
  trade_category_id: number
  field: 'quantity' | 'unit'
  ai_predicted: string | null
  human_corrected: string
  reason: string | null
  /** The candidate's own job's similarity-relevant metadata. */
  job_metadata: SimilarProject
}

export interface RankedCorrection extends CorrectionCandidate {
  similarity_score: number
}

/**
 * Ranks past corrections for one trade by similarity to the project
 * currently being estimated. Only corrections at or above
 * CORRECTION_MIN_SIMILARITY are returned — an unrelated project's
 * correction is worse than no signal at all.
 */
export function retrieveRelevantCorrections(
  candidates: CorrectionCandidate[],
  query: ProjectMetadata,
  tradeCategoryId: number,
  limit: number = CORRECTION_DEFAULT_LIMIT
): RankedCorrection[] {
  return candidates
    .filter((c) => c.trade_category_id === tradeCategoryId)
    .map((c) => ({ ...c, similarity_score: scoreProject(c.job_metadata, query).score }))
    .filter((c) => c.similarity_score >= CORRECTION_MIN_SIMILARITY)
    .sort((a, b) => b.similarity_score - a.similarity_score)
    .slice(0, limit)
}

/**
 * Formats ranked corrections as a short, evidence-labelled block a future
 * trade-estimator prompt can drop in alongside its project-model context —
 * kept here rather than duplicated at each future call site, even though
 * nothing calls it yet.
 */
export function formatCorrectionsForPrompt(corrections: RankedCorrection[]): string {
  if (corrections.length === 0) return ''
  const lines = corrections.map((c) => {
    const predicted = c.ai_predicted ?? 'no value'
    const reasonPart = c.reason ? ` — reason given: "${c.reason}"` : ''
    return `- On a similar past project, ${c.field} was predicted as "${predicted}" and corrected to "${c.human_corrected}"${reasonPart} (similarity ${c.similarity_score}%)`
  })
  return `Past corrections on comparable projects for this trade:\n${lines.join('\n')}`
}
