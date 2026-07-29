// ─── Construction sanity checks (Estimate QA layer) ────────────────────────────
// A construction-REASONING check, not a pricing check — deliberately separate
// from lib/pricing.ts and from Gates 1-3 (gates.ts, which only ever validate a
// single line item in isolation: does it have a unit, is the quantity
// traceable, is it positive). These rules look ACROSS line items and against
// Stage 3's own per-trade scope text (scope_items.included_scope/dependencies/
// assumptions) for the class of error neither pricing nor gating can ever see:
// a paint quantity that's internally impossible given the same estimate's own
// cladding area, a kitchen with no benchtop, a bathroom with no waterproofing.
//
// Extensible by design: each rule is one small object in CONSTRUCTION_SANITY_
// RULES below (appliesWhen + check) — adding a new construction-sanity check
// means adding one entry, not touching the evaluation loop. Mirrors the same
// "small data-like registry, not a hardcoded monolith" shape
// scope_intelligence_patterns already uses for its own likely-items list.
//
// Pure functions, no DB access — called once by runQualityAssurance (qa.ts)
// with data it already fetched, same integration pattern as findMissingTrades.

import { TRADE_CATEGORIES } from '../trade-taxonomy.ts'

export type ConstructionSanitySeverity = 'red' | 'amber'

export interface ConstructionSanityLineItem {
  trade_category_id: number
  description: string
  quantity: number | null
  unit: string | null
  assumption_status: string | null
}

export interface ConstructionSanityScopeItem {
  trade_category_id: number
  included_scope: string[] | null
  dependencies: string[] | null
  assumptions: string[] | null
}

export interface ConstructionSanityContext {
  lineItems: ConstructionSanityLineItem[]
  scopeItems: ConstructionSanityScopeItem[]
  /** Optional — raw project_facts text (e.g. every active fact's `value`),
   *  used ONLY by the coverage diagnostic's characteristic detection below.
   *  Forensic validation of this diagnostic found that line-item/scope text
   *  alone under-detects: a narrow, incomplete Stage 3 output is exactly
   *  the case LEAST likely to also restate "extension"/"second storey" in
   *  its own generated line items, so characteristic detection needs the
   *  project's own facts as a source too, not just what was (or wasn't)
   *  generated from them. Never read by any per-item construction-sanity
   *  rule — this stays pricing/rule-agnostic everywhere else. */
  projectFactsText?: string
  /** Optional — only used by the coverage diagnostic's "high-value project,
   *  too few trades" check below. Never read by any per-item rule; this
   *  module stays pricing-agnostic everywhere else, matching the estimator
   *  QA design principle that construction-sanity reasons about scope
   *  completeness, not price. */
  totalCost?: number | null
}

export interface ConstructionSanityFinding {
  id: string
  severity: ConstructionSanitySeverity
  /** Short label for a capped/scannable list — "Missing waterproofing allowance". */
  summary: string
  /** "What WorkA noticed" — the concrete observation, in plain language. */
  what_noticed: string
  /** "Why it matters" — the construction-reasoning consequence. */
  why_it_matters: string
  /** "Your action" — a single concrete next step. */
  builder_action: string
}

interface ConstructionSanityRule {
  id: string
  check: (ctx: ConstructionSanityContext) => ConstructionSanityFinding | null
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function included(ctx: ConstructionSanityContext): ConstructionSanityLineItem[] {
  return ctx.lineItems.filter((i) => i.assumption_status !== 'excluded')
}

function sumQuantity(items: ConstructionSanityLineItem[], predicate: (i: ConstructionSanityLineItem) => boolean): number {
  return items.filter(predicate).reduce((sum, i) => sum + (i.quantity ?? 0), 0)
}

function descriptionMatches(item: ConstructionSanityLineItem, keywords: string[]): boolean {
  const desc = item.description.toLowerCase()
  return keywords.some((k) => desc.includes(k))
}

function anyDescriptionMatches(items: ConstructionSanityLineItem[], keywords: string[]): boolean {
  return items.some((i) => descriptionMatches(i, keywords))
}

/** Scope text (included_scope + dependencies + assumptions) across every trade, lowercased, for keyword detection. */
function scopeText(ctx: ConstructionSanityContext): string {
  return ctx.scopeItems
    .flatMap((s) => [...(s.included_scope ?? []), ...(s.dependencies ?? []), ...(s.assumptions ?? [])])
    .join(' ')
    .toLowerCase()
}

// ─── Rules ──────────────────────────────────────────────────────────────────
// Trade category ids per lib/trade-taxonomy.ts: 1 Site Works & Concrete,
// 2 Framing, 3 Roofing, 4 External Cladding, 5 Insulation, 6 Internal
// Linings, 7 Fit-out Carpentry, 8 Cabinetry, 9 Paint, 10 Flooring,
// 11 Fixtures & Tapware, 12 Electrical, 13 Preliminaries.

const PAINT_TO_CLADDING_MAX_RATIO = 1.3

const paintVsCladdingArea: ConstructionSanityRule = {
  id: 'paint_vs_cladding_area',
  check(ctx) {
    const items = included(ctx)
    const externalPaintM2 = sumQuantity(items, (i) => i.trade_category_id === 9 && i.unit === 'm2' && descriptionMatches(i, ['external']))
    const claddingM2 = sumQuantity(items, (i) => i.trade_category_id === 4 && i.unit === 'm2')
    if (externalPaintM2 === 0 || claddingM2 === 0) return null
    if (externalPaintM2 <= claddingM2 * PAINT_TO_CLADDING_MAX_RATIO) return null
    return {
      id: 'paint_vs_cladding_area',
      severity: 'amber',
      summary: 'Paint quantity looks high',
      what_noticed: `Quoted external paint area (${Math.round(externalPaintM2)}m²) is well above the external wall area this estimate detected (${Math.round(claddingM2)}m²).`,
      why_it_matters: 'External paint cannot cover more wall than actually exists — this is usually a quantity extraction error, not a real difference in scope.',
      builder_action: 'Confirm the paint quantity against the plans, or check whether internal and external paint areas were split correctly.',
    }
  },
}

// A rough, deliberately-labeled heuristic (perimeter ≈ 3×√area for a typical
// extension footprint, not 4×√area/a perfect square, to allow for shared/
// party walls) — meant to be tuned once real project_memory/
// cost_reconciliation data exists to calibrate it, not treated as exact.
const FRAMING_PERIMETER_MULTIPLIER = 3.0
const FRAMING_UNDERESTIMATE_THRESHOLD = 0.5

const framingVsFootprint: ConstructionSanityRule = {
  id: 'framing_vs_footprint',
  check(ctx) {
    const items = included(ctx)
    const wallFramingLm = sumQuantity(items, (i) => i.trade_category_id === 2 && i.unit === 'lm')
    // Slab area is the most direct footprint proxy available; fall back to
    // roof/floor framing area (m2) if no slab line exists (e.g. an upper-
    // storey addition with no new ground slab).
    let footprintM2 = sumQuantity(items, (i) => i.trade_category_id === 1 && i.unit === 'm2' && descriptionMatches(i, ['slab']))
    if (footprintM2 === 0) {
      footprintM2 = sumQuantity(items, (i) => i.trade_category_id === 2 && i.unit === 'm2' && descriptionMatches(i, ['roof', 'floor']))
    }
    if (footprintM2 === 0) return null
    const expectedMinLm = FRAMING_PERIMETER_MULTIPLIER * Math.sqrt(footprintM2)
    if (wallFramingLm >= expectedMinLm * FRAMING_UNDERESTIMATE_THRESHOLD) return null
    return {
      id: 'framing_vs_footprint',
      severity: 'amber',
      summary: 'Framing quantity may be underestimated',
      what_noticed: `Wall framing (${Math.round(wallFramingLm)}lm) looks low for a footprint of roughly ${Math.round(footprintM2)}m².`,
      why_it_matters: 'A footprint this size typically needs meaningfully more linear metres of wall framing once perimeter and internal partitions are accounted for.',
      builder_action: 'Double-check the wall framing takeoff against the plans before relying on this quantity.',
    }
  },
}

const kitchenCompleteness: ConstructionSanityRule = {
  id: 'kitchen_completeness',
  check(ctx) {
    const items = included(ctx)
    const hasKitchenCabinetry = items.some((i) => i.trade_category_id === 8 && descriptionMatches(i, ['kitchen']))
    if (!hasKitchenCabinetry) return null
    const hasBenchtopOrSplashback = anyDescriptionMatches(items, ['benchtop', 'splashback'])
    if (hasBenchtopOrSplashback) return null
    return {
      id: 'kitchen_completeness',
      severity: 'red',
      summary: 'Kitchen scope may be incomplete',
      what_noticed: 'Kitchen cabinetry is scoped, but no benchtop or splashback line item exists.',
      why_it_matters: 'A kitchen quote without a benchtop is one of the first things a client (or another builder) will notice is missing.',
      builder_action: 'Add a benchtop and splashback line, or confirm they\'re covered elsewhere (e.g. supplied by the client).',
    }
  },
}

const BATHROOM_KEYWORDS = ['bathroom', 'ensuite', 'wet area']

const bathroomCompleteness: ConstructionSanityRule = {
  id: 'bathroom_completeness',
  check(ctx) {
    const items = included(ctx)
    const bathroomDetected = anyDescriptionMatches(items, BATHROOM_KEYWORDS) || BATHROOM_KEYWORDS.some((k) => scopeText(ctx).includes(k))
    if (!bathroomDetected) return null

    // Waterproofing is a BCA requirement for every wet area — this is the
    // one sub-check promoted to its own, higher-severity finding, matching
    // scope_intelligence_patterns' own bathroom_reno pattern (which already
    // rates waterproofing at 98% confidence expected-item, the highest of
    // any seeded hint).
    const hasWaterproofing = anyDescriptionMatches(items, ['waterproof'])
    if (!hasWaterproofing) {
      return {
        id: 'bathroom_completeness',
        severity: 'red',
        summary: 'Missing waterproofing allowance',
        what_noticed: 'A bathroom renovation is scoped, but no waterproofing line item exists.',
        why_it_matters: 'Waterproofing is required by the BCA for every wet area — its absence is almost always a missed line, not a genuine exclusion.',
        builder_action: 'Add a waterproofing line, or confirm it\'s covered elsewhere (e.g. a subcontractor\'s own scope).',
      }
    }

    // Secondary checklist — only reported once waterproofing itself is
    // covered, so the builder isn't shown two bathroom findings at once for
    // what's usually the same root cause (an incomplete bathroom scope).
    const missing: string[] = []
    if (!items.some((i) => i.trade_category_id === 10 && descriptionMatches(i, ['tile']))) missing.push('tiling')
    if (!items.some((i) => i.trade_category_id === 11)) missing.push('fixtures')
    if (!anyDescriptionMatches(items, ['exhaust', 'ventilat'])) missing.push('ventilation')
    if (missing.length === 0) return null
    return {
      id: 'bathroom_completeness',
      severity: 'amber',
      summary: 'Bathroom scope may be incomplete',
      what_noticed: `A bathroom renovation is scoped, but no line item covers: ${missing.join(', ')}.`,
      why_it_matters: 'These are standard inclusions for any bathroom renovation — a genuine exclusion is possible, but worth confirming.',
      builder_action: `Check whether ${missing.join(', ')} should be added, or confirm they're excluded deliberately.`,
    }
  },
}

const extensionStructuralDependency: ConstructionSanityRule = {
  id: 'extension_structural_dependency',
  check(ctx) {
    const items = included(ctx)
    const extensionDetected = anyDescriptionMatches(items, ['extension']) || scopeText(ctx).includes('extension')
    if (!extensionDetected) return null
    const hasStructural = anyDescriptionMatches(items, ['structural', 'engineer'])
    if (hasStructural) return null
    return {
      id: 'extension_structural_dependency',
      severity: 'amber',
      summary: 'Engineering not included',
      what_noticed: 'This job is scoped as an extension, but no structural engineering fee was found.',
      why_it_matters: 'New footings or a structural tie-in to the existing building almost always need a structural engineer.',
      builder_action: 'Confirm whether engineering is being handled separately, or add an engineering fee line.',
    }
  },
}

const CONSTRUCTION_SANITY_RULES: ConstructionSanityRule[] = [
  paintVsCladdingArea,
  framingVsFootprint,
  kitchenCompleteness,
  bathroomCompleteness,
  extensionStructuralDependency,
]

/**
 * Runs every registered rule and returns the findings, red first. Never
 * throws — a single rule's own logic error must not take down the rest of
 * QA (matches runQualityAssurance's own try/catch-per-section philosophy).
 */
export function evaluateConstructionSanity(ctx: ConstructionSanityContext): ConstructionSanityFinding[] {
  const findings: ConstructionSanityFinding[] = []
  for (const rule of CONSTRUCTION_SANITY_RULES) {
    try {
      const finding = rule.check(ctx)
      if (finding) findings.push(finding)
    } catch (err) {
      console.error(`evaluateConstructionSanity: rule "${rule.id}" failed:`, err)
    }
  }
  return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'red' ? -1 : 1))
}

// ─── Construction coverage diagnostic ───────────────────────────────────────
// Root-cause fix for a production estimate that reached ~$132k against an
// independently-estimated ~$2.3M for the same project: Stage 3's own prompt
// (supabase/functions/smooth-responder/index.ts) was rewritten to stop
// silently omitting trades it had no direct document mention for — but a
// second, independent line of defense belongs here, downstream, on the
// scope Stage 3 actually produced: does the TRADE COVERAGE itself look
// plausible for a project with these characteristics, regardless of why
// a trade might be missing. This is deliberately a cheap, deterministic,
// keyword-driven check — no new AI call, no new engine, extending the same
// rule registry above.
//
// Detection is characteristic-gated, not a flat trade-count minimum: a
// genuinely small bathroom-only renovation legitimately touches only 5-6
// trades and that is correct, not a defect. The checks below only fire when
// the project's OWN evidenced characteristics (extension, second storey,
// major renovation, new build, demolition) imply structural/envelope work
// that then turns out to be entirely absent.

export type ProjectCharacteristic = 'extension' | 'second_storey' | 'major_renovation' | 'new_build' | 'demolition'

const CHARACTERISTIC_KEYWORDS: Record<ProjectCharacteristic, string[]> = {
  extension: ['extension'],
  second_storey: ['second storey', 'second-storey', 'first floor addition', 'upper floor addition', 'new upper floor'],
  major_renovation: ['major renovation', 'alterations and additions', 'alteration and addition'],
  new_build: ['new build', 'new dwelling', 'new home', 'knockdown rebuild'],
  demolition: ['demolit'],
}

// The three trades a senior estimator would never expect to see entirely
// absent from a project characterized as an extension, second storey, major
// renovation, or new build — structure, roofing, and the external envelope
// tying it together.
const STRUCTURAL_TRADE_IDS = [2, 3, 4] // Framing, Roofing, External Cladding

// Below this many distinct trade categories represented, a project already
// evidenced as an extension/second-storey/major-renovation/new-build is
// unusually narrow — the exact shape of the $132k failure (an
// electrical-only or interior-only scope for what's actually a structural
// project). Deliberately conservative (13 trades exist; 6 is well under
// half) to avoid false positives on projects this genuinely doesn't apply
// to — the structural-trio check above is the higher-confidence signal.
const NARROW_COVERAGE_THRESHOLD = 6

// A project this large producing a suspiciously narrow trade spread is
// worth a second look even absent an explicit extension/reno keyword —
// deliberately a high bar so this never fires on an ordinary mid-size job.
const HIGH_VALUE_THRESHOLD = 500_000

export interface TradeCoverageResult {
  expected_trade_count: number
  detected_trade_count: number
  missing_trade_ids: number[]
  detected_characteristics: ProjectCharacteristic[]
  findings: ConstructionSanityFinding[]
}

function detectCharacteristics(ctx: ConstructionSanityContext): ProjectCharacteristic[] {
  const text = [
    ...ctx.lineItems.map((i) => i.description.toLowerCase()),
    scopeText(ctx),
    (ctx.projectFactsText ?? '').toLowerCase(),
  ].join(' ')
  return (Object.keys(CHARACTERISTIC_KEYWORDS) as ProjectCharacteristic[])
    .filter((c) => CHARACTERISTIC_KEYWORDS[c].some((k) => text.includes(k)))
}

function tradeName(id: number): string {
  return TRADE_CATEGORIES.find((t) => t.id === id)?.name ?? `Trade ${id}`
}

/**
 * The "expected N, detected N, missing N" answer to "why is this estimate
 * so much lower than expected" — cheap, deterministic, no pricing involved.
 * Called once per QA run, alongside evaluateConstructionSanity.
 */
export function evaluateConstructionCoverage(ctx: ConstructionSanityContext): TradeCoverageResult {
  const items = included(ctx)
  const detectedTradeIds = Array.from(new Set(items.map((i) => i.trade_category_id))).sort((a, b) => a - b)
  const characteristics = detectCharacteristics(ctx)
  const findings: ConstructionSanityFinding[] = []

  const impliesStructure = characteristics.some((c) => c === 'extension' || c === 'second_storey' || c === 'major_renovation' || c === 'new_build')
  const missingStructural = STRUCTURAL_TRADE_IDS.filter((id) => !detectedTradeIds.includes(id))

  if (impliesStructure && missingStructural.length === STRUCTURAL_TRADE_IDS.length) {
    const names = STRUCTURAL_TRADE_IDS.map(tradeName).join(', ')
    findings.push({
      id: 'coverage_structural_trades_absent',
      severity: 'red',
      summary: 'No structural, roofing or envelope scope at all',
      what_noticed: `This project is characterized as ${characteristics.filter((c) => c !== 'demolition').join('/')}, but ${names} have zero line items between them.`,
      why_it_matters: 'An extension, second storey, or major renovation always involves structural, framing, roofing and envelope work — its complete absence means the estimate is very likely missing the bulk of the physical construction, not just a few line items.',
      builder_action: 'Review Stage 3 scope reasoning for these three trades before treating this total as meaningful.',
    })
  }

  if (characteristics.includes('demolition') && !detectedTradeIds.includes(1)) {
    findings.push({
      id: 'coverage_demolition_without_site_works',
      severity: 'amber',
      summary: 'Demolition mentioned but no Site Works scope',
      what_noticed: 'Demolition is referenced in this project\'s facts or scope, but Site Works & Concrete has no line items at all.',
      why_it_matters: 'Demolition is almost always followed by site preparation and new footings/slab work — its complete absence from Site Works is worth confirming, not assuming.',
      builder_action: 'Confirm whether site works/new footings genuinely fall outside this quote, or whether they were missed.',
    })
  }

  const isNarrowForCharacteristics = characteristics.length > 0 && detectedTradeIds.length < NARROW_COVERAGE_THRESHOLD
  const isNarrowForValue = (ctx.totalCost ?? 0) >= HIGH_VALUE_THRESHOLD && detectedTradeIds.length < NARROW_COVERAGE_THRESHOLD
  if ((isNarrowForCharacteristics || isNarrowForValue) && findings.every((f) => f.id !== 'coverage_structural_trades_absent')) {
    findings.push({
      id: 'coverage_unusually_narrow',
      severity: 'amber',
      summary: `Only ${detectedTradeIds.length} of 13 trade categories represented`,
      what_noticed: isNarrowForValue && !isNarrowForCharacteristics
        ? `This is a high-value project but only ${detectedTradeIds.length} of the 13 trade categories have any line items.`
        : `This project is characterized as ${characteristics.join('/')}, but only ${detectedTradeIds.length} of the 13 trade categories have any line items.`,
      why_it_matters: 'A project of this description usually spans most of the standard trade categories — a narrow spread like this is the same shape of gap that has previously produced estimates far below a realistic total.',
      builder_action: 'Review which trades were never scoped at all — not just whether the scoped trades look priced correctly.',
    })
  }

  return {
    expected_trade_count: impliesStructure ? Math.max(NARROW_COVERAGE_THRESHOLD, detectedTradeIds.length) : detectedTradeIds.length,
    detected_trade_count: detectedTradeIds.length,
    missing_trade_ids: impliesStructure ? missingStructural : [],
    detected_characteristics: characteristics,
    findings,
  }
}
