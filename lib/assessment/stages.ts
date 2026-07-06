// ─── Assessment stage machine ─────────────────────────────────────────────────
// The four stages of the flow, expressed as pure orchestration over injected
// deps. No SQL, no prompts, no HTTP, no UI — each function calls services +
// repositories and returns the typed contract.

import type { AssessmentInput, AssessmentResult, RunContext, NextAction, UiHint } from './contract'
import type { AssessmentDeps } from './runner'
import type { RenderedExport } from '../services'
import type { ExportMeta } from '../estimate-export'
import type { ClassifiedDocument, ScopeReasoning } from '../estimation-reasoning'
import type { StoredQuestion } from '../repositories'
import { computeIsIndicative, ESSENTIAL_QUESTION_GROUPS } from '../services'

// ── Upload → intake+scoping ──────────────────────────────────────────────────
export async function runIntake(
  input: Extract<AssessmentInput, { kind: 'upload' }>,
  ctx: RunContext,
  deps: AssessmentDeps
): Promise<AssessmentResult> {
  const loaded = await deps.storage.load(input.fileIds, ctx.builderId)
  const assessed = await deps.services.reasoning.assess(loaded, null)

  await deps.repos.documents.replaceForJob(ctx.builderId, input.jobId, assessed.documents)
  await deps.repos.projectScope.upsert(ctx.builderId, input.jobId, assessed.scope, true)
  await deps.repos.openQuestions.replaceForJob(ctx.builderId, input.jobId, assessed.openQuestions)

  const questions = await deps.repos.openQuestions.listForJob(ctx.builderId, input.jobId)
  const failed = assessed.documents.filter((d) => d.extraction_status === 'failed').length

  return scopingResult(input.jobId, {
    documents: assessed.documents,
    scope: assessed.scope,
    questions,
    clarificationStatus: 'pending',
    isIndicative: true,
    summary: `${assessed.scope.complexity_rating} complexity · ${assessed.scope.recommended_estimate_type}. ${questions.length} questions before pricing${failed ? ` · ${failed} document${failed !== 1 ? 's' : ''} unreadable` : ''}.`,
    warnings: failed ? [{ severity: 'block' as const, message: `${failed} document(s) flagged unreadable — affected scope is provisional.` }] : undefined,
  })
}

// ── Clarifying questions (answer / skip / complete) ──────────────────────────
export async function resolveQuestions(
  input: Extract<AssessmentInput, { kind: 'answer_question' | 'skip_questions' | 'complete_questions' }>,
  ctx: RunContext,
  deps: AssessmentDeps
): Promise<AssessmentResult> {
  const stored = await deps.repos.projectScope.get(ctx.builderId, input.jobId)
  const recommended = stored?.recommendedEstimateType ?? 'Budget/Preliminary'
  let clarificationStatus = stored?.clarificationStatus ?? 'pending'
  let isIndicative = stored?.isIndicative ?? true

  if (input.kind === 'answer_question') {
    await deps.repos.openQuestions.answer(ctx.builderId, input.jobId, input.questionId, input.answer)
  } else if (input.kind === 'skip_questions') {
    clarificationStatus = 'skipped'
    isIndicative = computeIsIndicative({ clarificationStatus, recommendedEstimateType: recommended, essentialUnresolved: 0 })
    await deps.repos.projectScope.setClarification(ctx.builderId, input.jobId, 'skipped', isIndicative)
  } else {
    const essentialUnresolved = await deps.repos.openQuestions.essentialUnresolvedCount(ctx.builderId, input.jobId, ESSENTIAL_QUESTION_GROUPS)
    clarificationStatus = 'answered'
    isIndicative = computeIsIndicative({ clarificationStatus, recommendedEstimateType: recommended, essentialUnresolved })
    await deps.repos.projectScope.setClarification(ctx.builderId, input.jobId, 'answered', isIndicative)
  }

  const [documents, questions] = await Promise.all([
    deps.repos.documents.listForJob(ctx.builderId, input.jobId),
    deps.repos.openQuestions.listForJob(ctx.builderId, input.jobId),
  ])

  return scopingResult(input.jobId, {
    documents,
    scope: stored?.scope ?? emptyScope(),
    questions,
    clarificationStatus,
    isIndicative,
    summary:
      clarificationStatus === 'skipped'
        ? 'Skipped to an indicative estimate — every output is labelled budget-range.'
        : 'Answers recorded. Ready to generate the estimate.',
  })
}

// ── Estimate generation ──────────────────────────────────────────────────────
export async function generateEstimate(
  input: Extract<AssessmentInput, { kind: 'generate_estimate' }>,
  ctx: RunContext,
  deps: AssessmentDeps
): Promise<AssessmentResult> {
  const stored = await deps.repos.projectScope.get(ctx.builderId, input.jobId)
  if (!stored) throw new Error('No project scope — run the assessment first.')
  const documents = await deps.repos.documents.listForJob(ctx.builderId, input.jobId)
  const rateLibrary = input.pricingMode === 'user_supplied' ? await deps.repos.rates.loadLibrary(ctx.builderId) : []

  const estimate = await deps.services.estimation.generate({
    scope: stored.scope,
    documents,
    pricingMode: input.pricingMode,
    isIndicative: stored.isIndicative,
    recommendedEstimateType: stored.recommendedEstimateType,
    rateLibrary,
  })
  await deps.repos.quotes.saveEstimate(ctx.builderId, input.jobId, estimate)

  return {
    stage: 'estimate',
    jobId: input.jobId,
    isIndicative: estimate.is_indicative,
    summary: `${estimate.line_count} line items · ${estimate.pricing_mode === 'user_supplied' ? 'your rate library' : 'market rates'}.`,
    nextAction: { type: 'export', formats: ['xlsx', 'pdf', 'client'] },
    uiHints: [{ type: 'open_estimate', jobId: input.jobId }],
    warnings: estimate.guard_warnings.map((w) => ({ severity: w.severity, message: w.message })),
    data: { estimate },
  }
}

// ── Chat entry — maps a message onto a sub-action ─────────────────────────────
export async function fromChat(
  input: Extract<AssessmentInput, { kind: 'chat' }>,
  ctx: RunContext,
  deps: AssessmentDeps
): Promise<AssessmentResult> {
  const msg = input.message.toLowerCase()
  if (/\b(generate|build|create|do)\b.*\b(estimate|quote|price|pricing)\b/.test(msg) || /^price it/.test(msg)) {
    const pricingMode = /\b(my|library|supplied|own)\b.*rate|rate.*\b(library|list)\b/.test(msg) ? 'user_supplied' : 'market'
    return generateEstimate({ kind: 'generate_estimate', jobId: input.jobId, pricingMode }, ctx, deps)
  }
  if (/\bskip\b/.test(msg)) {
    return resolveQuestions({ kind: 'skip_questions', jobId: input.jobId }, ctx, deps)
  }
  // Default: return the current scoping snapshot so chat can show status.
  const stored = await deps.repos.projectScope.get(ctx.builderId, input.jobId)
  const [documents, questions] = await Promise.all([
    deps.repos.documents.listForJob(ctx.builderId, input.jobId),
    deps.repos.openQuestions.listForJob(ctx.builderId, input.jobId),
  ])
  return scopingResult(input.jobId, {
    documents,
    scope: stored?.scope ?? emptyScope(),
    questions,
    clarificationStatus: stored?.clarificationStatus ?? 'pending',
    isIndicative: stored?.isIndicative ?? true,
    summary: stored ? `${stored.scope.complexity_rating} complexity · ${questions.length} open questions.` : 'No assessment yet — upload the plans.',
  })
}

// ── Handover / export ────────────────────────────────────────────────────────
export async function handover(
  input: Extract<AssessmentInput, { kind: 'export' }>,
  ctx: RunContext,
  deps: AssessmentDeps
): Promise<RenderedExport> {
  const estimate = await deps.repos.quotes.latestForJob(ctx.builderId, input.jobId)
  if (!estimate) throw new Error('No estimate to export.')
  const stored = await deps.repos.projectScope.get(ctx.builderId, input.jobId)
  const scope = stored?.scope ?? emptyScope()
  const meta: ExportMeta = {
    projectName: scope.project_type || 'Estimate',
    address: scope.site_data.address ?? null,
    isIndicative: estimate.is_indicative,
    branding: { company_name: null, contact: null }, // settings-only; never invented
    assumptions: scope.assumptions,
    exclusions: scope.exclusions,
    risks: scope.risks,
    pricingMode: input.pricingMode ?? estimate.pricing_mode,
  }
  return deps.services.export.render(estimate, meta, input.format)
}

// ─── helpers ──────────────────────────────────────────────────────────────────

interface ScopingArgs {
  documents: ClassifiedDocument[]
  scope: ScopeReasoning
  questions: StoredQuestion[]
  clarificationStatus: string
  isIndicative: boolean
  summary: string
  warnings?: Array<{ severity: 'warn' | 'block'; message: string }>
}

function scopingResult(jobId: string, d: ScopingArgs): AssessmentResult {
  const nextAction: NextAction =
    d.clarificationStatus === 'pending'
      ? { type: 'answer_questions', questionCount: d.questions.length }
      : { type: 'generate_estimate', pricingModes: ['market', 'user_supplied'] }
  const uiHints: UiHint[] = [
    { type: 'open_project_assessment', jobId },
    { type: 'open_clarifying_questions', jobId },
  ]
  return {
    stage: 'scoping',
    jobId,
    isIndicative: d.isIndicative,
    summary: d.summary,
    nextAction,
    uiHints,
    warnings: d.warnings,
    data: { documents: d.documents, scope: d.scope, questions: d.questions, clarificationStatus: d.clarificationStatus },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emptyScope(): any {
  return {
    project_type: '', scope_summary: [], site_data: {}, room_scope: [], specialty_inclusions: [],
    date_mismatches: [], complexity_rating: 'Medium', complexity_justification: [],
    recommended_estimate_type: 'Budget/Preliminary', estimate_type_justification: '', trade_list: [],
    assumptions: [], risks: [], exclusions: [],
  }
}
