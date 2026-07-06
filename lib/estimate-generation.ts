// ─── Estimate generation engine (Stage 3) ─────────────────────────────────────
// Turns the reasoned scope object into a builder-grade estimate: 150–250 line
// items grouped by cost section, each with a basis and a source reference, with
// unreadable structural scope carried as provisional sums (never invented
// numbers). Three explicit guards defend against the failure modes seen in a
// competitor tool on this exact job.
//
// Taxonomy: the 13 trade categories stay locked for RATE RESOLUTION (the 5-tier
// engine keys off trade_category_id). A richer "estimate section" grouping sits
// on top for the builder-facing output (Prelims, Demolition, Pool, Landscaping,
// Contingency, …). location_scope is orthogonal — it tags which build a line
// belongs to (primary / secondary dwelling / pool / external).

// ─── Estimate sections (grouping) → locked trade category (rate bucket) ───────

export interface EstimateSectionDef {
  key: string
  label: string
  /** the locked 1–13 trade category used for rate resolution */
  trade_category_id: number
  order: number
}

export const ESTIMATE_SECTIONS: EstimateSectionDef[] = [
  { key: 'preliminaries',   label: 'Preliminaries',                 trade_category_id: 1,  order: 1 },
  { key: 'demolition',      label: 'Demolition',                    trade_category_id: 1,  order: 2 },
  { key: 'earthworks',      label: 'Earthworks & Site Prep',        trade_category_id: 1,  order: 3 },
  { key: 'concrete',        label: 'Concrete',                      trade_category_id: 2,  order: 4 },
  { key: 'structural',      label: 'Structural & Framing',          trade_category_id: 3,  order: 5 },
  { key: 'roofing',         label: 'Roofing',                       trade_category_id: 4,  order: 6 },
  { key: 'cladding',        label: 'External Cladding',             trade_category_id: 6,  order: 7 },
  { key: 'windows_doors',   label: 'Windows & External Doors',      trade_category_id: 5,  order: 8 },
  { key: 'insulation',      label: 'Insulation',                    trade_category_id: 7,  order: 9 },
  { key: 'linings',         label: 'Internal Linings',              trade_category_id: 8,  order: 10 },
  { key: 'waterproof_tile', label: 'Waterproofing & Tiling',        trade_category_id: 13, order: 11 },
  { key: 'flooring',        label: 'Flooring & Paving',             trade_category_id: 13, order: 12 },
  { key: 'joinery_stone',   label: 'Joinery & Stone',               trade_category_id: 9,  order: 13 },
  { key: 'painting',        label: 'Painting',                      trade_category_id: 10, order: 14 },
  { key: 'electrical_solar',label: 'Electrical & Solar',            trade_category_id: 12, order: 15 },
  { key: 'plumbing_hydr',   label: 'Plumbing, Gas & Hydraulics',    trade_category_id: 11, order: 16 },
  { key: 'hvac',            label: 'HVAC',                          trade_category_id: 11, order: 17 },
  { key: 'pool',            label: 'Pool & Pool Safety',            trade_category_id: 2,  order: 18 },
  { key: 'fixtures',        label: 'Fixtures & Fittings',           trade_category_id: 11, order: 19 },
  { key: 'external_works',  label: 'External Works & Landscaping',  trade_category_id: 1,  order: 20 },
  { key: 'specialist',      label: 'Specialist (Wellness / Theatre)', trade_category_id: 13, order: 21 },
  { key: 'completion',      label: 'Completion & Handover',         trade_category_id: 1,  order: 22 },
]

export const SECTION_BY_KEY: Record<string, EstimateSectionDef> = Object.fromEntries(
  ESTIMATE_SECTIONS.map((s) => [s.key, s])
)

export function sectionLabel(key: string): string {
  return SECTION_BY_KEY[key]?.label ?? key
}

export function tradeForSection(key: string): number {
  return SECTION_BY_KEY[key]?.trade_category_id ?? 1
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** measured = taken off / stated; allowance = builder/market allowance;
 *  pc_sum = prime cost (client-selected item, supply); provisional = scope known
 *  but under-specified (e.g. unreadable structural) — priced provisionally. */
export type EstimateBasis = 'measured' | 'allowance' | 'pc_sum' | 'provisional'

export type PricingType = 'measured' | 'pc_allowance' | 'provisional_sum'

export type LocationScope = 'primary' | 'secondary_dwelling' | 'pool' | 'external' | 'general'

export type PricingMode = 'market' | 'user_supplied'

export interface EstimateLineItem {
  section: string
  trade_category_id: number
  description: string
  location_scope: LocationScope
  source_ref: string | null
  quantity: number | null
  unit: string | null
  /** AUD ex-GST unit cost basis (before margin) */
  rate: number | null
  /** quantity × rate, ex-GST cost */
  total: number | null
  basis: EstimateBasis
  /** 0–100 */
  confidence: number
  notes: string | null
  /** set for user-supplied-rate mode when no library rate matched this scope */
  rate_unmatched?: boolean
}

export interface EstimateSectionGroup {
  key: string
  label: string
  trade_category_id: number
  items: EstimateLineItem[]
  subtotal: number
}

export interface GuardWarning {
  guard: 'window_flat_rating' | 'schedule_subtotal' | 'branding_field'
  severity: 'warn' | 'block'
  message: string
  refs?: string[]
}

export interface EstimateTotals {
  trade_subtotal: number
  contingency_pct: number
  contingency_amount: number
  margin_pct: number
  margin_amount: number
  total_ex_gst: number
  gst_pct: number
  gst_amount: number
  total_inc_gst: number
}

export interface RateMatchSummary {
  matched: number
  unmatched: number
  unmatched_items: Array<{ section: string; description: string; source_ref: string | null }>
}

export interface GeneratedEstimate {
  sections: EstimateSectionGroup[]
  line_count: number
  totals: EstimateTotals
  is_indicative: boolean
  pricing_mode: PricingMode
  guard_warnings: GuardWarning[]
  /** builder/company branding — sourced ONLY from settings, never documents */
  branding: { company_name: string | null; contact: string | null }
  confidence_summary: string
  /** present in user_supplied mode — how much of the scope the library covered */
  rate_match?: RateMatchSummary
  generated_at: string
  demo: boolean
}

// ─── Basis ⇄ pricing_type mapping (DB uses the enum, output shows the basis) ──

export function basisToPricingType(basis: EstimateBasis): PricingType {
  if (basis === 'provisional') return 'provisional_sum'
  if (basis === 'pc_sum') return 'pc_allowance'
  return 'measured' // measured + allowance both store as measured; basis carries the nuance
}

export function pricingTypeToBasis(pt: PricingType): EstimateBasis {
  if (pt === 'provisional_sum') return 'provisional'
  if (pt === 'pc_allowance') return 'pc_sum'
  return 'measured'
}

// ─── Model / defaults ─────────────────────────────────────────────────────────

export const ESTIMATE_GEN_MODEL = 'claude-sonnet-4-6'

export const DEFAULT_MARGIN_PCT = 18
export const DEFAULT_GST_PCT = 10
/** Contingency scales with documentation immaturity — higher at DA/concept. */
export const CONTINGENCY_BY_MATURITY: Record<string, number> = {
  concept: 15,
  da: 12.5,
  da_modification: 12.5,
  cc: 8,
  cdc: 8,
  ifc: 6,
  draft: 12.5,
  unknown: 10,
}

export function contingencyForMaturity(issueStatus: string | null | undefined): number {
  if (!issueStatus) return 10
  return CONTINGENCY_BY_MATURITY[issueStatus] ?? 10
}

// ─── Totals ───────────────────────────────────────────────────────────────────
// Prelims are a visible section of line items (not a hidden %). Contingency,
// margin and GST are visible roll-ups on top of the trade subtotal — never
// buried inside trade rates.

export function computeEstimateTotals(
  tradeSubtotal: number,
  contingencyPct: number,
  marginPct: number = DEFAULT_MARGIN_PCT,
  gstPct: number = DEFAULT_GST_PCT
): EstimateTotals {
  const round = (n: number) => Math.round(n * 100) / 100
  const subtotal = round(tradeSubtotal)
  const contingency = round((subtotal * contingencyPct) / 100)
  const margin = round(((subtotal + contingency) * marginPct) / 100)
  const totalExGst = round(subtotal + contingency + margin)
  const gst = round((totalExGst * gstPct) / 100)
  return {
    trade_subtotal: subtotal,
    contingency_pct: contingencyPct,
    contingency_amount: contingency,
    margin_pct: marginPct,
    margin_amount: margin,
    total_ex_gst: totalExGst,
    gst_pct: gstPct,
    gst_amount: gst,
    total_inc_gst: round(totalExGst + gst),
  }
}

/** Group flat line items into ordered sections with subtotals. */
export function groupIntoSections(items: EstimateLineItem[]): EstimateSectionGroup[] {
  const round = (n: number) => Math.round(n * 100) / 100
  return ESTIMATE_SECTIONS.map((def) => {
    const sectionItems = items.filter((i) => i.section === def.key)
    const subtotal = round(sectionItems.reduce((s, i) => s + (i.total ?? 0), 0))
    return { key: def.key, label: def.label, trade_category_id: def.trade_category_id, items: sectionItems, subtotal }
  }).filter((g) => g.items.length > 0)
}

// ═══════════════════════════════════════════════════════════════════════════
// GUARDS — the brief's three explicit failure modes to prevent
// ═══════════════════════════════════════════════════════════════════════════

// ── Guard 1: window/door flat-rating ─────────────────────────────────────────
// The competitor priced ~20 scheduled windows at one of two flat rates despite
// the schedule supporting individual take-off. Flag a windows/doors group that
// collapses many measured items onto very few distinct rates.

export function checkWindowFlatRating(
  items: EstimateLineItem[],
  opts: { minItems?: number; maxDistinctRates?: number } = {}
): GuardWarning | null {
  const minItems = opts.minItems ?? 5
  const maxDistinctRates = opts.maxDistinctRates ?? 2

  const windows = items.filter(
    (i) => i.section === 'windows_doors' && i.basis === 'measured' && i.rate !== null && (i.quantity ?? 0) > 0
  )
  if (windows.length < minItems) return null

  const distinctRates = new Set(windows.map((i) => i.rate as number))
  if (distinctRates.size > maxDistinctRates) return null

  return {
    guard: 'window_flat_rating',
    severity: 'warn',
    message: `${windows.length} scheduled windows/doors priced across only ${distinctRates.size} flat rate${distinctRates.size !== 1 ? 's' : ''}. The schedule supports individual take-off by size and glazing spec — price each opening, don't flat-rate.`,
    refs: Array.from(new Set(windows.map((i) => i.source_ref).filter((r): r is string => Boolean(r)))),
  }
}

// ── Guard 2: schedule-subtotal cross-check ───────────────────────────────────
// The competitor copied a schedule subtotal across as a PC allowance without
// checking the subtotal only covered a selected subset (most rows were $0 /
// unselected). Cross-check coverage before trusting a subtotal as an allowance.

export interface ScheduleRow {
  label?: string
  /** the row's client/selected amount — 0 or null means unselected */
  amount: number | null
}

export function crossCheckScheduleSubtotal(input: {
  subtotal: number
  rows: ScheduleRow[]
  scheduleName?: string
}): { safeToUseAsAllowance: boolean; pricedCount: number; unpricedCount: number; warning: GuardWarning | null } {
  const priced = input.rows.filter((r) => (r.amount ?? 0) > 0)
  const unpriced = input.rows.filter((r) => (r.amount ?? 0) <= 0)
  const pricedCount = priced.length
  const unpricedCount = unpriced.length
  const total = input.rows.length

  // Safe only when the subtotal actually reflects (nearly) the whole schedule.
  const coverage = total > 0 ? pricedCount / total : 0
  const safe = total > 0 && coverage >= 0.8

  if (safe) return { safeToUseAsAllowance: true, pricedCount, unpricedCount, warning: null }

  const name = input.scheduleName ? `"${input.scheduleName}" ` : ''
  return {
    safeToUseAsAllowance: false,
    pricedCount,
    unpricedCount,
    warning: {
      guard: 'schedule_subtotal',
      severity: 'block',
      message: `Schedule ${name}subtotal ($${input.subtotal.toLocaleString('en-AU')}) covers only ${pricedCount} of ${total} rows — ${unpricedCount} are unselected / $0. Do NOT carry this subtotal across as a full allowance; it prices a subset, not the scope.`,
      refs: input.scheduleName ? [input.scheduleName] : undefined,
    },
  }
}

// ── Guard 3: branding-field lockout ──────────────────────────────────────────
// The competitor invented a company name/phone by misreading a drawing
// title-block field. Branding/contact fields must come ONLY from explicit
// company settings — never from document content. This returns the settings
// value, and refuses any candidate that leaked from a document's author/title
// block (including a fuzzy match), producing a block-level warning instead.

export function resolveBrandingField(
  settingsValue: string | null | undefined,
  candidateFromDocument: string | null | undefined,
  documentAuthors: string[]
): { value: string | null; warning: GuardWarning | null } {
  const settings = (settingsValue ?? '').trim()
  if (settings) return { value: settings, warning: null }

  const candidate = (candidateFromDocument ?? '').trim()
  if (!candidate) return { value: null, warning: null }

  // A non-empty candidate with no settings value means something tried to
  // populate branding from a document — refuse it.
  const leakedFromDoc = documentAuthors.some((a) => fuzzyContains(a, candidate) || fuzzyContains(candidate, a))
  return {
    value: null,
    warning: {
      guard: 'branding_field',
      severity: 'block',
      message: leakedFromDoc
        ? `Refused to use "${candidate}" as company branding — it matches a document title-block/author field, not your company settings. Set branding in company settings.`
        : `Refused to populate company branding from document content ("${candidate}"). Branding comes only from your company settings.`,
    },
  }
}

function fuzzyContains(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const nb = b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (!na || !nb) return false
  return na.includes(nb)
}

/** Run every guard over a generated estimate and its source schedules. */
export function runGuards(input: {
  items: EstimateLineItem[]
  schedules?: Array<{ name: string; subtotal: number; rows: ScheduleRow[] }>
  branding?: { settingsCompany?: string | null; candidateCompany?: string | null; documentAuthors?: string[] }
}): GuardWarning[] {
  const warnings: GuardWarning[] = []

  const flat = checkWindowFlatRating(input.items)
  if (flat) warnings.push(flat)

  for (const s of input.schedules ?? []) {
    const res = crossCheckScheduleSubtotal({ subtotal: s.subtotal, rows: s.rows, scheduleName: s.name })
    if (res.warning) warnings.push(res.warning)
  }

  if (input.branding) {
    const res = resolveBrandingField(
      input.branding.settingsCompany,
      input.branding.candidateCompany,
      input.branding.documentAuthors ?? []
    )
    if (res.warning) warnings.push(res.warning)
  }

  return warnings
}

// ═══════════════════════════════════════════════════════════════════════════
// GENERATION (real mode) — prompt, tool schema, normaliser, Claude call
// ═══════════════════════════════════════════════════════════════════════════

import type { LlmProvider } from './providers/llm'

export const GEN_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    line_items: {
      type: 'array',
      description: 'The full estimate. Target 150–250 items for a project of this scope; never pad, never truncate.',
      items: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: ESTIMATE_SECTIONS.map((s) => s.key) },
          description: { type: 'string' },
          location_scope: { type: 'string', enum: ['primary', 'secondary_dwelling', 'pool', 'external', 'general'] },
          source_ref: { type: ['string', 'null'], description: 'Drawing/schedule reference, or null for a builder/market allowance.' },
          quantity: { type: ['number', 'null'] },
          unit: { type: ['string', 'null'], description: 'm2 | lm | m | m3 | ea | hr | wk | lot' },
          rate: { type: ['number', 'null'], description: 'AUD ex-GST unit COST (before margin). null if unpriceable.' },
          basis: {
            type: 'string',
            enum: ['measured', 'allowance', 'pc_sum', 'provisional'],
            description: 'provisional for scope that is referenced but under-specified (e.g. unreadable structural) — NEVER an invented specific figure.',
          },
          confidence: { type: 'integer', minimum: 0, maximum: 100 },
          notes: { type: ['string', 'null'] },
        },
        required: ['section', 'description', 'location_scope', 'basis', 'confidence'],
      },
    },
    confidence_summary: { type: 'string' },
  },
  required: ['line_items', 'confidence_summary'],
}

export function buildGenerationSystemPrompt(): string {
  return `You are WorkA's estimating engine — a senior Australian residential QS. You have already reasoned about this project; now produce the estimate itself as a detailed, builder-grade line-item takeoff.

RULES:
1. Target 150–250 line items for a luxury alts & adds + pool + secondary dwelling. Scale honestly to scope — never pad to hit a number, never truncate real scope.
2. Group every line under one of the provided sections. Tag location_scope (primary / secondary_dwelling / pool / external).
3. Each line carries a basis: measured (taken off / stated), allowance (builder/market), pc_sum (client-selected prime cost), provisional (scope known but under-specified).
4. Rates are ex-GST COST (before margin). Margin, contingency and GST are added as visible roll-ups later — never bake them into a rate.
5. NEVER fabricate a specific technical fact — a structural member size, an engineering figure, a quantity — that isn't in the documents. Where structural detail is unreadable, the framing/steel/footing lines are basis=provisional ("pending engineering confirmation"), never an invented number dressed up as measured.
6. Prefer INDIVIDUAL take-off over flat rates. Scheduled windows/doors of differing size/glazing must be priced per opening, not collapsed onto one or two flat rates.
7. Do NOT copy a finishes-schedule subtotal across as an allowance without checking coverage — if most rows are $0/unselected, the subtotal is a subset, not the scope. Use a realistic PC allowance for the full scope and note the schedule is unpriced.
8. NEVER populate any company/branding/contact field from a drawing title block or document author — that comes only from company settings.
9. source_ref every measured/pc line to its drawing or schedule; allowances may be null but note the basis.

Return via the generate_estimate tool.`
}

export function buildGenerationUserText(scopeSummary: string, pricingMode: PricingMode): string {
  return `${scopeSummary}

Pricing mode: ${pricingMode === 'user_supplied' ? "USER-SUPPLIED RATES — apply the builder's rate library line-by-line where a match exists; flag any scope with no matching rate rather than silently using a market rate." : 'MARKET RATE — use current regionally-appropriate benchmark rates, clearly indicative and requiring verification against live quotes before tender.'}

Produce the full estimate now via the generate_estimate tool.`
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

function asBasis(v: unknown): EstimateBasis {
  return v === 'measured' || v === 'allowance' || v === 'pc_sum' || v === 'provisional' ? v : 'allowance'
}
function asLocation(v: unknown): LocationScope {
  return v === 'primary' || v === 'secondary_dwelling' || v === 'pool' || v === 'external' || v === 'general'
    ? v
    : 'general'
}

/** Normalise loose tool output into typed line items, computing totals. A
 *  provisional line with no rate is kept (surfaces in the PS schedule) rather
 *  than dropped. */
export function normaliseLineItems(toolInput: unknown): { items: EstimateLineItem[]; confidenceSummary: string } {
  const input = (toolInput ?? {}) as { line_items?: unknown[]; confidence_summary?: unknown }
  const rows = Array.isArray(input.line_items) ? input.line_items : []
  const items: EstimateLineItem[] = []

  for (const entry of rows) {
    if (typeof entry !== 'object' || entry === null) continue
    const it = entry as Record<string, unknown>
    const description = str(it.description)
    const sectionKey = str(it.section)
    if (!description || !sectionKey || !SECTION_BY_KEY[sectionKey]) continue

    const basis = asBasis(it.basis)
    const quantity = num(it.quantity)
    const rate = num(it.rate)
    // Allowances / provisional sums default quantity to 1 lot.
    const isAllowance = basis === 'allowance' || basis === 'pc_sum' || basis === 'provisional'
    const qty = quantity === null && isAllowance ? 1 : quantity
    const total = qty !== null && rate !== null ? Math.round(qty * rate * 100) / 100 : null

    items.push({
      section: sectionKey,
      trade_category_id: tradeForSection(sectionKey),
      description,
      location_scope: asLocation(it.location_scope),
      source_ref: str(it.source_ref),
      quantity: qty,
      unit: str(it.unit) ?? (isAllowance ? 'lot' : null),
      rate,
      total,
      basis,
      confidence: num(it.confidence) !== null ? Math.max(0, Math.min(100, Math.round(it.confidence as number))) : 50,
      notes: str(it.notes),
    })
  }

  return { items, confidenceSummary: str(input.confidence_summary) ?? '' }
}

/** Real-mode generation — a tool-use call through the injected LlmProvider. */
export async function generateEstimateItems(
  llm: LlmProvider,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  docBlocks: any[],
  scopeSummary: string,
  pricingMode: PricingMode,
  timeoutMs = 240_000
): Promise<{ items: EstimateLineItem[]; confidenceSummary: string }> {
  const toolInput = await llm.toolCall({
    model: ESTIMATE_GEN_MODEL,
    maxTokens: 16000,
    system: buildGenerationSystemPrompt(),
    blocks: docBlocks,
    userText: buildGenerationUserText(scopeSummary, pricingMode),
    toolName: 'generate_estimate',
    schema: GEN_TOOL_SCHEMA,
    timeoutMs,
  })
  return normaliseLineItems(toolInput)
}

/** Assemble sections + totals + guards into the final estimate object. */
export function assembleEstimate(input: {
  items: EstimateLineItem[]
  contingencyPct: number
  marginPct?: number
  gstPct?: number
  isIndicative: boolean
  pricingMode: PricingMode
  guardWarnings: GuardWarning[]
  branding: { company_name: string | null; contact: string | null }
  confidenceSummary: string
  rateMatch?: RateMatchSummary
  demo: boolean
}): GeneratedEstimate {
  const sections = groupIntoSections(input.items)
  const tradeSubtotal = sections.reduce((s, g) => s + g.subtotal, 0)
  const totals = computeEstimateTotals(tradeSubtotal, input.contingencyPct, input.marginPct, input.gstPct)
  return {
    sections,
    line_count: input.items.length,
    totals,
    is_indicative: input.isIndicative,
    pricing_mode: input.pricingMode,
    guard_warnings: input.guardWarnings,
    branding: input.branding,
    confidence_summary: input.confidenceSummary,
    rate_match: input.rateMatch,
    generated_at: new Date().toISOString(),
    demo: input.demo,
  }
}
