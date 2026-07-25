// ─── Unresolved line item diagnostics (Part 2) ─────────────────────────────
// Read-only classification of quote_line_items that currently contribute $0
// (pricing_source = 'unresolved') into three buckets a builder/estimator can
// act on differently. Deliberately diagnostic only — nothing here writes a
// price, an allowance, or a gate; see scripts/dev-diagnose-unresolved.mjs
// for the read-only report script that calls this against a real quote.
//
// "Unresolved" today conflates two structurally different failure origins
// that happen to land on the same pricing_source value:
//   1. Stage 6 itself never offered a quantity/unit or an allowance for the
//      scope (smooth-responder/index.ts's validateStage6Items sets
//      pricing_source='unresolved' when a gate fires and no allowance_value
//      was set).
//   2. Stage 6 DID give a real quantity+unit, but lib/pricing.ts's full
//      5-tier + fallback chain still failed to resolve a rate.
// This module doesn't need to know which of those wrote a given row — the
// classification below is derived purely from the row's own current
// quantity/unit/pricing_type, which is exactly the same evidence a human
// reviewer would look at.

export type UnresolvedCategory = 'measured_pricing_failure' | 'allowance_candidate' | 'true_unresolved'

export interface UnresolvedItemInput {
  id: string
  description: string
  trade_category_id: number
  quantity: number | null
  unit: string | null
  pricing_type: string | null
  /** Gate 1/2 from the associated assumptions row, if one exists — informational only, not part of the classification rule itself. */
  gate: 1 | 2 | 3 | null
  gate_message: string | null
}

export interface ClassifiedUnresolvedItem extends UnresolvedItemInput {
  category: UnresolvedCategory
  /** False only for true_unresolved — the one category where auto-pricing would be irresponsible with what's currently known. */
  has_enough_information: boolean
}

/**
 * Category A (measured_pricing_failure): a real quantity AND unit are both
 * present — Stage 6 understood and measured the scope ("36m2 concrete
 * slab", "3.45lm kitchen joinery" from the task spec); whatever failed,
 * failed at pricing, not understanding. This is intentionally the FIRST
 * check — a quantity+unit pair is decisive regardless of pricing_type.
 *
 * Category B (allowance_candidate): no usable quantity/unit, but Stage 6
 * itself already flagged this line as allowance-shaped work
 * (pricing_type pc_allowance/provisional_sum) — e.g. specialist equipment,
 * a complex installation, an unknown supplier selection. The scope is
 * understood; only a $ figure is missing, which is exactly what AI
 * Allowances (migration 071) already knows how to produce for lines like
 * this — these rows are candidates for that same mechanism reaching them.
 *
 * Category C (true_unresolved): neither of the above — no measurable
 * quantity/unit and nothing marking this as allowance-shaped scope either.
 * Genuinely insufficient information; estimating a number here would be
 * irresponsible rather than merely imprecise.
 */
export function classifyUnresolvedItem(item: Pick<UnresolvedItemInput, 'quantity' | 'unit' | 'pricing_type'>): UnresolvedCategory {
  const hasQuantity = item.quantity !== null && item.quantity !== undefined
  const hasUnit = item.unit !== null && item.unit !== undefined && item.unit !== ''
  if (hasQuantity && hasUnit) return 'measured_pricing_failure'
  if (item.pricing_type === 'pc_allowance' || item.pricing_type === 'provisional_sum') return 'allowance_candidate'
  return 'true_unresolved'
}

/** Whether this classification carries enough information to responsibly assign a price today — false only for true_unresolved. */
export function hasEnoughInformationToPrice(category: UnresolvedCategory): boolean {
  return category !== 'true_unresolved'
}

export function classifyUnresolvedItems(items: UnresolvedItemInput[]): ClassifiedUnresolvedItem[] {
  return items.map((item) => {
    const category = classifyUnresolvedItem(item)
    return { ...item, category, has_enough_information: hasEnoughInformationToPrice(category) }
  })
}

export interface UnresolvedCategorySummary {
  category: UnresolvedCategory
  item_count: number
  /**
   * Always 0 by definition — every item in this report has total = null
   * today. This field exists so the report shape directly answers "total
   * estimated value impact" per the task spec, honestly: the CURRENT
   * contribution of every unresolved item is zero, which is the entire
   * problem. Any non-zero figure would be a fabricated estimate for items
   * this module deliberately does not price — see the diagnostic script's
   * own header for how it separately (and clearly-labelled) shows an
   * illustrative comparison value, without writing it here.
   */
  current_value_impact: 0
  examples: Array<{ id: string; description: string; trade_category_id: number }>
  recommended_next_action: string
}

export const UNRESOLVED_CATEGORY_RECOMMENDED_ACTIONS: Record<UnresolvedCategory, string> = {
  measured_pricing_failure:
    'Extend measured-pricing coverage (rate catalogue / category fallback / AI measured rate) for these trade+unit combinations — Stage 6 already produced a real quantity and unit; only rate resolution failed.',
  allowance_candidate:
    "Extend Stage 6's allowance generation so lines already flagged pc_allowance/provisional_sum receive a proposed dollar figure — the scope is understood, only the number is missing, which is the same gap AI Allowances already closes for other lines.",
  true_unresolved:
    'Leave as a builder-input item — raise a clarifying question or require manual entry. Do not auto-price with what is currently known.',
}

const ALL_CATEGORIES: UnresolvedCategory[] = ['measured_pricing_failure', 'allowance_candidate', 'true_unresolved']

export interface UnresolvedDiagnosticsReport {
  total_items: number
  categories: UnresolvedCategorySummary[]
}

/** Groups already-classified items into the per-category summary the task spec asks for (count, examples, recommended action) — pure, no DB access. */
export function buildUnresolvedDiagnosticsReport(classified: ClassifiedUnresolvedItem[]): UnresolvedDiagnosticsReport {
  return {
    total_items: classified.length,
    categories: ALL_CATEGORIES.map((category) => {
      const items = classified.filter((i) => i.category === category)
      return {
        category,
        item_count: items.length,
        current_value_impact: 0,
        examples: items.slice(0, 5).map((i) => ({ id: i.id, description: i.description, trade_category_id: i.trade_category_id })),
        recommended_next_action: UNRESOLVED_CATEGORY_RECOMMENDED_ACTIONS[category],
      }
    }),
  }
}
