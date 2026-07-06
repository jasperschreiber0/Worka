// ─── Domain services ──────────────────────────────────────────────────────────
// Thin façades that compose the estimation libs into the interfaces the runner
// depends on. The demo/real split lives here too: demo services return fixtures,
// real services call the injected LlmProvider. No service imports Supabase or the
// Anthropic SDK directly — data comes via repos, LLM via the provider.

import {
  classifyDocuments,
  reasonAboutScope,
  ESSENTIAL_QUESTION_GROUPS,
  computeIsIndicative,
  type ClassifiedDocument,
  type ScopeReasoning,
  type OpenQuestion,
  type StatedPurpose,
  type ClarificationStatus,
  type EstimateType,
} from './estimation-reasoning'
import {
  generateEstimateItems,
  assembleEstimate,
  runGuards,
  contingencyForMaturity,
  type GeneratedEstimate,
  type PricingMode,
} from './estimate-generation'
import { applyRateLibrary, type RateLibraryEntry } from './rate-library'
import { buildEstimateWorkbook, buildBuilderHtml, buildClientQuoteHtml, type ExportMeta } from './estimate-export'
import { DEMO_ASSESSMENT } from './estimation-assessment-demo'
import { buildDemoEstimate } from './estimate-demo'
import type { LlmProvider } from './providers/llm'
import type { LoadedDoc } from './providers/storage'

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface Assessed {
  documents: ClassifiedDocument[]
  scope: ScopeReasoning
  openQuestions: OpenQuestion[]
}

export interface ReasoningService {
  assess(loaded: LoadedDoc[], statedPurpose: StatedPurpose): Promise<Assessed>
}

export interface EstimationService {
  generate(input: {
    scope: ScopeReasoning
    documents: ClassifiedDocument[]
    pricingMode: PricingMode
    isIndicative: boolean
    recommendedEstimateType: EstimateType
    rateLibrary: RateLibraryEntry[]
  }): Promise<GeneratedEstimate>
}

export interface RenderedExport {
  contentType: string
  body: Buffer | string
  filename?: string
}

export interface ExportService {
  render(estimate: GeneratedEstimate, meta: ExportMeta, format: 'xlsx' | 'pdf' | 'client'): RenderedExport
}

export interface Services {
  reasoning: ReasoningService
  estimation: EstimationService
  export: ExportService
}

export { ESSENTIAL_QUESTION_GROUPS, computeIsIndicative }
export type { ClarificationStatus }

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createServices(mode: 'demo' | 'real', deps: { llm: LlmProvider }): Services {
  return {
    reasoning: mode === 'demo' ? demoReasoning() : realReasoning(deps.llm),
    estimation: mode === 'demo' ? demoEstimation() : realEstimation(deps.llm),
    export: exportService(), // pure — identical in both modes
  }
}

// ─── Reasoning ────────────────────────────────────────────────────────────────

function demoReasoning(): ReasoningService {
  return {
    async assess() {
      return { documents: DEMO_ASSESSMENT.documents, scope: DEMO_ASSESSMENT.scope, openQuestions: DEMO_ASSESSMENT.open_questions }
    },
  }
}

function realReasoning(llm: LlmProvider): ReasoningService {
  return {
    async assess(loaded, statedPurpose) {
      const { buildTextLayerBlock } = await import('./pdf-text')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blocks: any[] = []
      for (const d of loaded) {
        blocks.push(d.block)
        if (d.textLayer) blocks.push(buildTextLayerBlock(d.textLayer))
      }
      const files = loaded.map((d) => ({ file_id: d.file_id, filename: d.filename, textLayer: d.textLayer }))
      const documents = await classifyDocuments(llm, blocks, files)
      const { scope, openQuestions } = await reasonAboutScope(llm, blocks, documents, statedPurpose)
      return { documents, scope, openQuestions }
    },
  }
}

// ─── Estimation ───────────────────────────────────────────────────────────────

function demoEstimation(): EstimationService {
  return {
    async generate({ pricingMode }) {
      return buildDemoEstimate(pricingMode)
    },
  }
}

function realEstimation(llm: LlmProvider): EstimationService {
  return {
    async generate({ scope, documents, pricingMode, isIndicative, rateLibrary }) {
      const summary = buildScopeSummary(scope)
      const gen = await generateEstimateItems(llm, [], summary, pricingMode)
      let items = gen.items
      let rateMatch
      if (pricingMode === 'user_supplied' && rateLibrary.length > 0) {
        const res = applyRateLibrary(items, rateLibrary)
        items = res.items
        rateMatch = { matched: res.matched, unmatched: res.unmatched, unmatched_items: res.unmatched_items }
      }
      const documentAuthors = documents.map((d) => d.author).filter((a): a is string => Boolean(a))
      const guardWarnings = runGuards({ items, branding: { settingsCompany: null, candidateCompany: null, documentAuthors } })
      const maturity = leastMatureStatus(documents.map((d) => d.issue_status))
      return assembleEstimate({
        items, contingencyPct: contingencyForMaturity(maturity), isIndicative,
        pricingMode, guardWarnings, branding: { company_name: null, contact: null },
        confidenceSummary: gen.confidenceSummary, rateMatch, demo: false,
      })
    },
  }
}

// ─── Export (pure) ────────────────────────────────────────────────────────────

function exportService(): ExportService {
  return {
    render(estimate, meta, format) {
      const safe = meta.projectName.replace(/[^a-z0-9]+/gi, '-').slice(0, 40).replace(/^-|-$/g, '') || 'estimate'
      if (format === 'xlsx') {
        return {
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          body: buildEstimateWorkbook(estimate, meta),
          filename: `${safe}-estimate.xlsx`,
        }
      }
      if (format === 'client') {
        return { contentType: 'text/html; charset=utf-8', body: buildClientQuoteHtml(estimate, meta) }
      }
      return { contentType: 'text/html; charset=utf-8', body: buildBuilderHtml(estimate, meta) }
    },
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function buildScopeSummary(scope: ScopeReasoning): string {
  const parts: string[] = [`PROJECT: ${scope.project_type}`, `Complexity: ${scope.complexity_rating}`]
  if (scope.scope_summary.length) parts.push('Scope:\n' + scope.scope_summary.map((s) => `- ${s}`).join('\n'))
  const sd = scope.site_data
  parts.push(`Site: ${[sd.address, sd.zoning, sd.proposed_gfa_m2 ? `${sd.proposed_gfa_m2}m² GFA` : null].filter(Boolean).join(', ')}`)
  if (scope.specialty_inclusions.length) parts.push('Specialty:\n' + scope.specialty_inclusions.map((s) => `- ${s.item}`).join('\n'))
  if (scope.trade_list.length) parts.push('Trades:\n' + scope.trade_list.map((t) => `- ${t.trade}: ${t.reason}`).join('\n'))
  if (scope.risks.length) parts.push('Risks (price affected scope provisional):\n' + scope.risks.map((r) => `- ${r}`).join('\n'))
  return parts.join('\n\n')
}

function leastMatureStatus(statuses: Array<string | null | undefined>): string {
  const order = ['concept', 'da', 'da_modification', 'draft', 'cdc', 'cc', 'ifc']
  let worst = 'unknown'
  let worstIdx = 999
  for (const s of statuses) {
    if (!s) continue
    const idx = order.indexOf(s)
    if (idx >= 0 && idx < worstIdx) { worstIdx = idx; worst = s }
  }
  return worst
}
