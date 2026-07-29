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
