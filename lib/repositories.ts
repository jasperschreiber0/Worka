// ─── Repositories (data-access layer) ─────────────────────────────────────────
// The ONLY place that talks to Supabase, and the ONLY place the demo/real branch
// lives. Everything above (services, runner, routes) depends on these interfaces
// and never imports the Supabase client. The real impls quarantine the untyped
// admin client (as the intake worker does today); when we want stricter typing
// we swap createClient() → createClient<Database>() here with no caller changes.

import {
  type ClassifiedDocument,
  type ScopeReasoning,
  type OpenQuestion,
  type ClarificationStatus,
  type EstimateType,
} from './estimation-reasoning'
import {
  groupIntoSections,
  computeEstimateTotals,
  basisToPricingType,
  pricingTypeToBasis,
  tradeForSection,
  type GeneratedEstimate,
  type EstimateLineItem,
} from './estimate-generation'
import { DEMO_ASSESSMENT } from './estimation-assessment-demo'
import { buildDemoEstimate, DEMO_RATE_LIBRARY } from './estimate-demo'
import type { RateLibraryEntry } from './rate-library'

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export type StoredQuestion = OpenQuestion & { id: string; resolved: boolean; answer: string | null }

export interface StoredScope {
  scope: ScopeReasoning
  isIndicative: boolean
  clarificationStatus: ClarificationStatus
  recommendedEstimateType: EstimateType
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface DocumentsRepo {
  replaceForJob(builderId: string, jobId: string, docs: ClassifiedDocument[]): Promise<void>
  listForJob(builderId: string, jobId: string): Promise<ClassifiedDocument[]>
}

export interface ProjectScopeRepo {
  upsert(builderId: string, jobId: string, scope: ScopeReasoning, isIndicative: boolean): Promise<void>
  get(builderId: string, jobId: string): Promise<StoredScope | null>
  setClarification(builderId: string, jobId: string, status: ClarificationStatus, isIndicative: boolean): Promise<void>
}

export interface OpenQuestionsRepo {
  replaceForJob(builderId: string, jobId: string, qs: OpenQuestion[]): Promise<void>
  listForJob(builderId: string, jobId: string): Promise<StoredQuestion[]>
  answer(builderId: string, jobId: string, questionId: string, answer: string): Promise<void>
  essentialUnresolvedCount(builderId: string, jobId: string, essentialGroups: string[]): Promise<number>
}

export interface QuoteRepo {
  saveEstimate(builderId: string, jobId: string, est: GeneratedEstimate): Promise<{ quoteId: string }>
  latestForJob(builderId: string, jobId: string): Promise<GeneratedEstimate | null>
}

export interface RatesRepo {
  /** the builder's supplier + preference rates, for user-supplied pricing mode */
  loadLibrary(builderId: string): Promise<RateLibraryEntry[]>
}

export interface Repositories {
  documents: DocumentsRepo
  projectScope: ProjectScopeRepo
  openQuestions: OpenQuestionsRepo
  quotes: QuoteRepo
  rates: RatesRepo
}

/** The single demo/real switch for all data access. */
export function createRepositories(mode: 'demo' | 'real'): Repositories {
  return mode === 'demo' ? createDemoRepositories() : createSupabaseRepositories()
}

// ─── Real (Supabase) implementation — untyped client quarantined here ─────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adminClient(): any {
  // Lazily required so this module stays importable in environments without the
  // SDK (e.g. the demo path never calls this).
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
  const { createClient } = require('@supabase/supabase-js')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

function createSupabaseRepositories(): Repositories {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = adminClient()

  const documents: DocumentsRepo = {
    async replaceForJob(builderId, jobId, docs) {
      await db.from('documents').delete().eq('builder_id', builderId).eq('job_id', jobId)
      if (docs.length === 0) return
      await db.from('documents').insert(
        docs.map((d) => ({
          builder_id: builderId, job_id: jobId, file_id: d.file_id, filename: d.filename,
          category: d.category, category_confidence: d.category_confidence, issue_status: d.issue_status,
          document_date: d.document_date, author: d.author, extraction_status: d.extraction_status,
          content_summary: d.content_summary, unreadable_reason: d.unreadable_reason,
        }))
      )
    },
    async listForJob(builderId, jobId) {
      const { data } = await db.from('documents').select('*').eq('builder_id', builderId).eq('job_id', jobId).order('created_at')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (data ?? []).map((r: any): ClassifiedDocument => ({
        file_id: r.file_id ?? null, filename: r.filename, category: r.category,
        category_confidence: r.category_confidence ?? 50, issue_status: r.issue_status ?? 'unknown',
        document_date: r.document_date ?? null, author: r.author ?? null,
        extraction_status: r.extraction_status ?? 'partial', content_summary: r.content_summary ?? '',
        unreadable_reason: r.unreadable_reason ?? null,
      }))
    },
  }

  const projectScope: ProjectScopeRepo = {
    async upsert(builderId, jobId, scope, isIndicative) {
      await db.from('project_scope').upsert(
        {
          builder_id: builderId, job_id: jobId, project_type: scope.project_type,
          scope_summary: scope.scope_summary, site_data: scope.site_data, room_scope: scope.room_scope,
          specialty_inclusions: scope.specialty_inclusions, date_mismatches: scope.date_mismatches,
          complexity_rating: scope.complexity_rating, complexity_justification: scope.complexity_justification,
          recommended_estimate_type: scope.recommended_estimate_type, estimate_type_justification: scope.estimate_type_justification,
          trade_list: scope.trade_list, assumptions: scope.assumptions, risks: scope.risks, exclusions: scope.exclusions,
          is_indicative: isIndicative, updated_at: new Date().toISOString(),
        },
        { onConflict: 'job_id' }
      )
    },
    async get(builderId, jobId) {
      const { data: r } = await db.from('project_scope').select('*').eq('builder_id', builderId).eq('job_id', jobId).maybeSingle()
      if (!r) return null
      const scope: ScopeReasoning = {
        project_type: r.project_type ?? '', scope_summary: r.scope_summary ?? [], site_data: r.site_data ?? {},
        room_scope: r.room_scope ?? [], specialty_inclusions: r.specialty_inclusions ?? [], date_mismatches: r.date_mismatches ?? [],
        complexity_rating: r.complexity_rating ?? 'Medium', complexity_justification: r.complexity_justification ?? [],
        recommended_estimate_type: r.recommended_estimate_type ?? 'Budget/Preliminary',
        estimate_type_justification: r.estimate_type_justification ?? '', trade_list: r.trade_list ?? [],
        assumptions: r.assumptions ?? [], risks: r.risks ?? [], exclusions: r.exclusions ?? [],
      }
      return {
        scope, isIndicative: r.is_indicative ?? true,
        clarificationStatus: (r.clarification_status as ClarificationStatus) ?? 'pending',
        recommendedEstimateType: (r.recommended_estimate_type as EstimateType) ?? 'Budget/Preliminary',
      }
    },
    async setClarification(builderId, jobId, status, isIndicative) {
      await db.from('project_scope').update({ clarification_status: status, is_indicative: isIndicative, updated_at: new Date().toISOString() })
        .eq('builder_id', builderId).eq('job_id', jobId)
    },
  }

  const openQuestions: OpenQuestionsRepo = {
    async replaceForJob(builderId, jobId, qs) {
      await db.from('open_questions').delete().eq('builder_id', builderId).eq('job_id', jobId)
      if (qs.length === 0) return
      await db.from('open_questions').insert(
        qs.map((q) => ({ builder_id: builderId, job_id: jobId, question_group: q.group, question_text: q.question, source_reference: q.source_reference }))
      )
    },
    async listForJob(builderId, jobId) {
      const { data } = await db.from('open_questions').select('*').eq('builder_id', builderId).eq('job_id', jobId).order('created_at')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (data ?? []).map((q: any): StoredQuestion => ({
        id: q.id, group: q.question_group, question: q.question_text, source_reference: q.source_reference ?? null,
        resolved: Boolean(q.resolved), answer: q.answer ?? null,
      }))
    },
    async answer(builderId, jobId, questionId, answer) {
      const a = answer.trim()
      await db.from('open_questions').update({ resolved: a.length > 0, answer: a || null })
        .eq('id', questionId).eq('builder_id', builderId).eq('job_id', jobId)
    },
    async essentialUnresolvedCount(builderId, jobId, essentialGroups) {
      const { data } = await db.from('open_questions').select('question_group, resolved').eq('builder_id', builderId).eq('job_id', jobId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (data ?? []).filter((q: any) => essentialGroups.includes(q.question_group) && !q.resolved).length
    },
  }

  const quotes: QuoteRepo = {
    async saveEstimate(builderId, jobId, est) {
      const { data: quoteRow } = await db.from('quotes').insert({
        job_id: jobId, builder_id: builderId, status: 'draft', total_cost: est.totals.trade_subtotal,
        margin_pct: est.totals.margin_pct, contingency_pct: est.totals.contingency_pct, gst_pct: est.totals.gst_pct, version: 1,
      }).select().single()
      if (!quoteRow) return { quoteId: `quote-${jobId.slice(0, 8)}` }
      const flat = est.sections.flatMap((s) => s.items)
      if (flat.length > 0) {
        await db.from('quote_line_items').insert(flat.map((i) => ({
          quote_id: quoteRow.id, trade_category_id: i.trade_category_id, description: i.description,
          quantity: i.quantity, unit: i.unit, rate: i.rate, total: i.total, confidence: i.confidence,
          pricing_type: basisToPricingType(i.basis), basis: i.basis, estimate_section: i.section,
          location_scope: i.location_scope, source_ref: i.source_ref, notes: i.notes,
          margin_pct: i.basis === 'provisional' ? 0 : est.totals.margin_pct / 100,
        })))
      }
      return { quoteId: quoteRow.id }
    },
    async latestForJob(builderId, jobId) {
      const { data: quoteRow } = await db.from('quotes').select('id, contingency_pct, margin_pct, gst_pct')
        .eq('builder_id', builderId).eq('job_id', jobId).order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (!quoteRow) return null
      const { data: liRows } = await db.from('quote_line_items').select('*').eq('quote_id', quoteRow.id)
      const { data: scopeRow } = await db.from('project_scope').select('is_indicative').eq('builder_id', builderId).eq('job_id', jobId).maybeSingle()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: EstimateLineItem[] = (liRows ?? []).map((r: any) => ({
        section: r.estimate_section ?? 'preliminaries', trade_category_id: r.trade_category_id ?? tradeForSection(r.estimate_section ?? 'preliminaries'),
        description: r.description, location_scope: r.location_scope ?? 'general', source_ref: r.source_ref ?? null,
        quantity: r.quantity ?? null, unit: r.unit ?? null, rate: r.rate ?? null, total: r.total ?? null,
        basis: r.basis ?? pricingTypeToBasis(r.pricing_type ?? 'measured'), confidence: r.confidence ?? 50, notes: r.notes ?? null,
      }))
      const sections = groupIntoSections(items)
      const totals = computeEstimateTotals(sections.reduce((s, g) => s + g.subtotal, 0), quoteRow.contingency_pct ?? 10, quoteRow.margin_pct ?? 18, quoteRow.gst_pct ?? 10)
      return {
        sections, line_count: items.length, totals, is_indicative: scopeRow?.is_indicative ?? true,
        pricing_mode: 'market', guard_warnings: [], branding: { company_name: null, contact: null },
        confidence_summary: '', generated_at: new Date().toISOString(), demo: false,
      }
    },
  }

  const rates: RatesRepo = {
    async loadLibrary(builderId) {
      const [{ data: supplier }, { data: prefs }] = await Promise.all([
        db.from('builder_supplier_rates').select('*').eq('builder_id', builderId),
        db.from('builder_rate_preferences').select('*').eq('builder_id', builderId),
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toEntry = (r: any): RateLibraryEntry => ({
        key: r.line_item_key ?? null, description: r.description ?? null, unit: r.unit ?? null,
        rate: typeof r.rate === 'number' ? r.rate : parseFloat(r.rate), trade_category_id: r.trade_category_id ?? null,
      })
      return [...(supplier ?? []), ...(prefs ?? [])].map(toEntry).filter((e) => Number.isFinite(e.rate) && e.rate > 0)
    },
  }

  return { documents, projectScope, openQuestions, quotes, rates }
}

// ─── Demo implementation — fixture-backed, writes are no-ops (stateless) ──────

function createDemoRepositories(): Repositories {
  return {
    documents: {
      async replaceForJob() { /* demo is stateless */ },
      async listForJob() { return DEMO_ASSESSMENT.documents },
    },
    projectScope: {
      async upsert() { /* no-op */ },
      async get() {
        return {
          scope: DEMO_ASSESSMENT.scope, isIndicative: true, clarificationStatus: 'pending',
          recommendedEstimateType: DEMO_ASSESSMENT.scope.recommended_estimate_type,
        }
      },
      async setClarification() { /* no-op */ },
    },
    openQuestions: {
      async replaceForJob() { /* no-op */ },
      async listForJob() {
        return DEMO_ASSESSMENT.open_questions.map((q, i): StoredQuestion => ({ ...q, id: `demo-q-${i}`, resolved: false, answer: null }))
      },
      async answer() { /* no-op */ },
      async essentialUnresolvedCount() { return 0 },
    },
    quotes: {
      async saveEstimate() { return { quoteId: 'demo-quote' } },
      async latestForJob() { return buildDemoEstimate('market') },
    },
    rates: {
      async loadLibrary() { return DEMO_RATE_LIBRARY },
    },
  }
}
