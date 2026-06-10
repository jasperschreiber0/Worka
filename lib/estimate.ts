// ─── AI estimate engine ─────────────────────────────────────────────────────────
// Shared by the intake pipeline. Extracts builder-level line items from one plan
// document at a time with Claude (streaming, large output budget — a multi-file
// plan set truncates a single small call), merges items across the set, applies
// the quantity validation gates, and computes the estimate totals
// (contingency / margin / GST kept separate — never hidden inside trade rates).

import type { EstimateTotals } from './intake-store'

// ─── Constants ────────────────────────────────────────────────────────────────

export const ESTIMATE_MODEL = 'claude-opus-4-8'

export const DEFAULT_CONTINGENCY_PCT = 8
export const DEFAULT_MARGIN_PCT = 18
export const DEFAULT_GST_PCT = 10

/** The 13 trade categories (sort_order locked, names per migration 012-era model) */
export const TRADE_CATEGORIES = [
  { id: 1, name: 'Earthworks & Site Prep' },
  { id: 2, name: 'Concrete' },
  { id: 3, name: 'Framing & Structural' },
  { id: 4, name: 'Roofing' },
  { id: 5, name: 'Windows & External Doors' },
  { id: 6, name: 'External Cladding' },
  { id: 7, name: 'Insulation' },
  { id: 8, name: 'Internal Linings' },
  { id: 9, name: 'Joinery & Cabinetry' },
  { id: 10, name: 'Painting' },
  { id: 11, name: 'Plumbing' },
  { id: 12, name: 'Electrical' },
  { id: 13, name: 'Tiling & Finishes' },
] as const

export function tradeCategoryName(id: number): string {
  return TRADE_CATEGORIES.find((c) => c.id === id)?.name ?? `Trade ${id}`
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type PricingType = 'measured' | 'pc_allowance' | 'provisional_sum'
export type PricingBasis = 'measured' | 'inferred' | 'allowance'

export interface ExtractedItem {
  trade_category_id: number
  description: string
  quantity: number | null
  unit: string | null
  /** AUD ex GST unit rate suggested by the estimator AI */
  rate: number | null
  dimensions_string: string | null
  /** 0–100 */
  confidence: number
  pricing_type: PricingType
  pricing_basis: PricingBasis
  /** Canonical snake_case key used to look up the 5-tier rate hierarchy */
  line_item_key: string | null
  subcategory_code: string | null
  source_ref: string | null
  notes: string | null
  labour_cost: number | null
  material_cost: number | null
  subcontract_cost: number | null
  plant_cost: number | null
}

export interface ValidatedItem extends ExtractedItem {
  total: number | null
  is_assumption: boolean
  assumption_status: 'unresolved' | 'excluded' | null
}

export interface AssumptionNote {
  description: string
  gate: number
  message: string
}

// ─── Extraction output contract (appended to the route's prompt) ─────────────

export const LINE_ITEM_FIELDS_SPEC = `
For each line item provide:
- trade_category_id (1–13)
- description (specific builder-level item name incl. room/location where known)
- quantity (numeric — calculate from dimensions where possible, or null if truly indeterminate. PC allowances and provisional sums use quantity 1.)
- unit ("m2" | "lm" | "m3" | "each" | "lot" | "hrs" | "weeks" — PC/PS items use "lot")
- rate (AUD ex GST unit rate — realistic current market rate for the project's state. Do NOT add builder's margin, contingency or GST to rates; those are applied separately. null only if you genuinely cannot price it)
- dimensions_string (the measurement evidence, e.g. "14.2m × 8.6m = 122.1m²" or "counted 14 on plan" — null if none)
- confidence (0–100: 95+ = scaled/stated in documents, 70–94 = measured/counted from drawings, 40–69 = professional inference, <40 = flagged for review)
- pricing_type: "measured" | "pc_allowance" | "provisional_sum". Where a schedule lists $0/blank/TBC, create a PC allowance with a realistic amount. Where structural scope is referenced but under-specified, create a provisional sum.
- pricing_basis: "measured" (from stated values/measurements) | "inferred" (reasonably inferred from drawings) | "allowance" (allowance only — needs a quote)
- line_item_key: canonical snake_case rate key, e.g. "concrete_slab_m2", "wall_framing_lm", "downlight_install_each"
- subcategory_code (e.g. "ELEC-POWER", "TILE-FLOOR") or null
- source_ref: drawing/schedule reference (e.g. "DA.A105", "Window Schedule") or null
- notes: assumptions, exclusions, or what needs confirming — null if none
- labour_cost / material_cost / subcontract_cost / plant_cost: AUD component estimates or null

Where a schedule lists actual RRP values, use them as the rate. Custom joinery shown in elevations must be priced at high-end custom rates, not project-home rates. Never invent quantities — set quantity null and explain in notes instead.

Return ONLY valid JSON:
{
  "line_items": [ { ...fields above... } ],
  "confidence_summary": "1 sentence overall confidence assessment"
}`

// ─── Robust JSON parsing ──────────────────────────────────────────────────────

export function parseExtractionJson(raw: string): {
  items: ExtractedItem[]
  confidenceSummary: string
} {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) text = fenceMatch[1].trim()
  if (!text.startsWith('{')) {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) return { items: [], confidenceSummary: '' }
    text = text.slice(start, end + 1)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { items: [], confidenceSummary: '' }
  }

  const obj = parsed as { line_items?: unknown[]; confidence_summary?: unknown }
  const rawItems = Array.isArray(obj.line_items) ? obj.line_items : []
  const confidenceSummary = typeof obj.confidence_summary === 'string' ? obj.confidence_summary : ''

  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

  const items: ExtractedItem[] = []
  for (const entry of rawItems) {
    if (typeof entry !== 'object' || entry === null) continue
    const it = entry as Record<string, unknown>
    const categoryId = Number(it.trade_category_id)
    const description = typeof it.description === 'string' ? it.description.trim() : ''
    if (!description || !Number.isInteger(categoryId) || categoryId < 1 || categoryId > 13) continue

    const pricingType: PricingType =
      it.pricing_type === 'pc_allowance' || it.pricing_type === 'provisional_sum'
        ? it.pricing_type
        : 'measured'
    const pricingBasis: PricingBasis =
      it.pricing_basis === 'inferred' || it.pricing_basis === 'allowance'
        ? it.pricing_basis
        : pricingType === 'measured'
          ? 'measured'
          : 'allowance'

    items.push({
      trade_category_id: categoryId,
      description,
      quantity: num(it.quantity),
      unit: str(it.unit),
      rate: num(it.rate),
      dimensions_string: str(it.dimensions_string),
      confidence:
        num(it.confidence) !== null
          ? Math.max(0, Math.min(100, Math.round(it.confidence as number)))
          : 0,
      pricing_type: pricingType,
      pricing_basis: pricingBasis,
      line_item_key: str(it.line_item_key),
      subcategory_code: str(it.subcategory_code),
      source_ref: str(it.source_ref),
      notes: str(it.notes),
      labour_cost: num(it.labour_cost),
      material_cost: num(it.material_cost),
      subcontract_cost: num(it.subcontract_cost),
      plant_cost: num(it.plant_cost),
    })
  }
  return { items, confidenceSummary }
}

// ─── Per-document extraction call ─────────────────────────────────────────────
// One document block per call, streamed with a large output budget — a single
// small non-streaming call truncates on real plan sets and the JSON fails to
// parse, which was the root cause of "Could not extract line items".

export async function extractItemsFromBlock(
  apiKey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  docBlock: any,
  prompt: string
): Promise<{ items: ExtractedItem[]; confidenceSummary: string }> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client = new Anthropic({ apiKey })

  const params = {
    model: ESTIMATE_MODEL,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: [docBlock, { type: 'text', text: prompt }] }],
  }

  // The installed SDK predates document blocks / adaptive thinking in its
  // types — pass params untyped; the API accepts them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = client.messages.stream(params as any)
  const finalMessage = await stream.finalMessage()

  const text = finalMessage.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')

  return parseExtractionJson(text)
}

// ─── Merge items across documents ─────────────────────────────────────────────

export function mergeExtractedItems(batches: ExtractedItem[][]): ExtractedItem[] {
  const byKey = new Map<string, ExtractedItem>()
  for (const batch of batches) {
    for (const item of batch) {
      const key = `${item.trade_category_id}|${item.description.toLowerCase().replace(/\s+/g, ' ')}`
      const existing = byKey.get(key)
      // Same item seen in multiple documents — keep the higher-confidence read
      if (!existing || item.confidence > existing.confidence) {
        byKey.set(key, item)
      }
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => a.trade_category_id - b.trade_category_id || a.description.localeCompare(b.description)
  )
}

// ─── Quantity validation gates ────────────────────────────────────────────────
// Gate 1: measured item with no unit → unresolved assumption
// Gate 2: measured area/length quantity with no dimensional evidence → unresolved
// Gate 3: zero/negative quantity → auto-excluded
// Gate 4: very low confidence (<40) on a priced measured item → unresolved
// PC allowances and provisional sums are explicit allowances, not invented
// quantities — they surface in the PC/PS schedule instead of blocking.

const DIMENSIONAL_UNITS = new Set(['m2', 'sqm', 'm²', 'lm', 'm3', 'm³', 'm'])

export function applyValidationGates(items: ExtractedItem[]): {
  validated: ValidatedItem[]
  assumptions: AssumptionNote[]
} {
  const assumptions: AssumptionNote[] = []

  const validated = items.map((item): ValidatedItem => {
    let isAssumption = false
    let status: 'unresolved' | 'excluded' | null = null

    const isAllowance = item.pricing_type !== 'measured'

    if (!isAllowance) {
      if (item.quantity !== null && item.quantity <= 0) {
        isAssumption = true
        status = 'excluded'
        assumptions.push({
          description: item.description,
          gate: 3,
          message: `Invalid quantity (${item.quantity}) for ${item.description} — excluded from quote`,
        })
      } else if (!item.unit) {
        isAssumption = true
        status = 'unresolved'
        assumptions.push({
          description: item.description,
          gate: 1,
          message: `Quantity unit not specified — please confirm the unit for ${item.description}`,
        })
      } else if (
        item.quantity !== null &&
        DIMENSIONAL_UNITS.has(item.unit.toLowerCase()) &&
        !item.dimensions_string
      ) {
        isAssumption = true
        status = 'unresolved'
        assumptions.push({
          description: item.description,
          gate: 2,
          message: `Quantity could not be verified from plans — confirm ${item.quantity} ${item.unit} for ${item.description}`,
        })
      } else if (item.confidence < 40 && item.rate !== null) {
        isAssumption = true
        status = 'unresolved'
        assumptions.push({
          description: item.description,
          gate: 4,
          message: `Low confidence extraction — confirm quantity and rate for ${item.description}`,
        })
      }
    }

    const quantity = isAllowance && item.quantity === null ? 1 : item.quantity
    const total =
      status !== 'excluded' && quantity !== null && item.rate !== null
        ? Math.round(quantity * item.rate * 100) / 100
        : null

    return {
      ...item,
      quantity,
      unit: isAllowance && !item.unit ? 'lot' : item.unit,
      total,
      is_assumption: isAssumption,
      assumption_status: status,
    }
  })

  return { validated, assumptions }
}

// ─── Estimate totals ──────────────────────────────────────────────────────────

export function computeEstimateTotals(
  items: Array<{ total: number | null; assumption_status: string | null }>,
  contingencyPct: number = DEFAULT_CONTINGENCY_PCT,
  marginPct: number = DEFAULT_MARGIN_PCT,
  gstPct: number = DEFAULT_GST_PCT
): EstimateTotals {
  const round = (n: number) => Math.round(n * 100) / 100

  const subtotal = round(
    items.reduce(
      (sum, item) => (item.assumption_status === 'excluded' ? sum : sum + (item.total ?? 0)),
      0
    )
  )
  const contingency = round((subtotal * contingencyPct) / 100)
  // Margin applies to direct cost + contingency, shown separately — never
  // hidden inside trade rates.
  const margin = round(((subtotal + contingency) * marginPct) / 100)
  const totalExGst = round(subtotal + contingency + margin)
  const gst = round((totalExGst * gstPct) / 100)

  return {
    subtotal,
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

// ─── Quote confidence score ───────────────────────────────────────────────────
// Weighted toward the LOWEST line item so one bad extraction cannot be hidden.

export function computeConfidenceScore(
  items: Array<{ confidence: number; assumption_status: string | null }>
): number {
  const included = items.filter((i) => i.assumption_status !== 'excluded')
  if (included.length === 0) return 0
  const min = Math.min(...included.map((i) => i.confidence))
  const avg = included.reduce((s, i) => s + i.confidence, 0) / included.length
  return Math.round(min * 0.6 + avg * 0.4)
}

// ─── 5-tier rate hierarchy lookup (Supabase mode only) ────────────────────────
// Tier 1 builder_learned_rates → 2 builder_rate_preferences →
// 3 builder_supplier_rates → 4 cost_rates (state-aware) →
// 5 network_rate_aggregates (P50). Falls back to the AI's market rate.

export async function resolveRatesFromHierarchy(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  builderId: string,
  state: string | null,
  items: ExtractedItem[]
): Promise<ExtractedItem[]> {
  const keys = Array.from(
    new Set(items.map((i) => i.line_item_key).filter((k): k is string => Boolean(k)))
  )
  if (keys.length === 0) return items

  const tiers: Array<Map<string, number>> = []
  try {
    const [learned, prefs, supplier, costRates, network] = await Promise.all([
      supabase.from('builder_learned_rates').select('line_item_key, rate').eq('builder_id', builderId).in('line_item_key', keys),
      supabase.from('builder_rate_preferences').select('line_item_key, rate').eq('builder_id', builderId).in('line_item_key', keys),
      supabase.from('builder_supplier_rates').select('line_item_key, rate').eq('builder_id', builderId).in('line_item_key', keys),
      supabase.from('cost_rates').select('line_item_key, rate, state').in('line_item_key', keys),
      supabase.from('network_rate_aggregates').select('line_item_key, rate_p50, state').in('line_item_key', keys),
    ])

    const toMap = (
      rows: Array<{ line_item_key: string; rate?: number; rate_p50?: number | null; state?: string | null }> | null,
      preferState = false
    ) => {
      const map = new Map<string, number>()
      for (const row of rows ?? []) {
        const rate = row.rate ?? row.rate_p50
        if (rate === null || rate === undefined) continue
        // State-specific rows win over national defaults
        if (map.has(row.line_item_key) && preferState && row.state !== state) continue
        if (!map.has(row.line_item_key) || (preferState && row.state === state)) {
          map.set(row.line_item_key, rate)
        }
      }
      return map
    }

    tiers.push(
      toMap(learned.data),
      toMap(prefs.data),
      toMap(supplier.data),
      toMap(costRates.data, true),
      toMap(network.data, true)
    )
  } catch {
    // Rate tables unavailable — keep AI market rates
    return items
  }

  return items.map((item) => {
    if (!item.line_item_key) return item
    for (const tier of tiers) {
      const rate = tier.get(item.line_item_key)
      if (rate !== undefined) {
        return { ...item, rate }
      }
    }
    return item
  })
}
