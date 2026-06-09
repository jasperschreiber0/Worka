// ─── AI estimate engine ─────────────────────────────────────────────────────────
// Shared by the intake pipeline in both modes (Supabase + in-memory). Reads a set
// of plan documents with Claude, extracts builder-level line items mapped to the
// 13 locked trade categories, prices them, applies the quantity validation gates,
// and computes the estimate totals (contingency / margin / GST kept separate —
// never hidden inside trade rates).

import type { EstimateTotals } from './intake-store'

// ─── Constants ────────────────────────────────────────────────────────────────

export const ESTIMATE_MODEL = 'claude-opus-4-8'

export const DEFAULT_CONTINGENCY_PCT = 8
export const DEFAULT_MARGIN_PCT = 18
export const DEFAULT_GST_PCT = 10

/** The 13 immutable trade categories (sort_order 1–13, seeded in migration 001) */
export const TRADE_CATEGORIES = [
  { id: 1, name: 'Site Works & Concrete' },
  { id: 2, name: 'Framing' },
  { id: 3, name: 'Roofing' },
  { id: 4, name: 'External Cladding' },
  { id: 5, name: 'Insulation' },
  { id: 6, name: 'Internal Linings' },
  { id: 7, name: 'Fit-out Carpentry' },
  { id: 8, name: 'Cabinetry' },
  { id: 9, name: 'Paint' },
  { id: 10, name: 'Flooring' },
  { id: 11, name: 'Fixtures & Tapware' },
  { id: 12, name: 'Electrical' },
  { id: 13, name: 'Preliminaries' },
] as const

export function tradeCategoryName(id: number): string {
  return TRADE_CATEGORIES.find((c) => c.id === id)?.name ?? 'Preliminaries'
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ItemType = 'measured' | 'pc_allowance' | 'provisional_sum'
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
  item_type: ItemType
  pricing_basis: PricingBasis
  /** Canonical snake_case key used to look up the 5-tier rate hierarchy */
  line_item_key: string | null
  notes: string | null
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

export interface IntakeDocument {
  filename: string
  media_type: string
  base64: string
}

// ─── Extraction prompt ────────────────────────────────────────────────────────

function buildSystemPrompt(state: string): string {
  return `You are a senior residential construction estimator for a custom builder in ${state}, Australia. You read architectural plans, structural drawings, electrical layouts, materials & finishes schedules, fixtures/fittings/appliance schedules, joinery elevations and lighting schedules, then produce builder-level estimate line items for an internal tender estimate.

How to work:
- First identify what kind of document you are reading, then extract every estimate-relevant line item it supports.
- Build the estimate from line items — do NOT apply a single square-metre rate.
- NEVER invent quantities. If a quantity cannot be determined from the document, set quantity to null and explain in notes.
- Where a schedule lists actual RRP values, use them. Where a schedule shows $0, blank, or "TBC", create a PC allowance (item_type "pc_allowance") with a realistic allowance and note "to be confirmed".
- Where structural members, engineering details or scope are referenced but not fully specified, create a provisional sum (item_type "provisional_sum") with a realistic allowance.
- Custom joinery shown in elevations (kitchens, butler's pantries, vanities, wardrobes) must be priced with high-end custom joinery allowances, not project-home rates.
- Separate supply and install where the document supports it (e.g. tile supply vs laying labour, light fitting PC item vs electrician fit-off).
- Rates are AUD excluding GST, realistic current market rates for ${state} residential custom/renovation work. Do NOT add builder's margin, contingency or GST to rates — those are applied separately.

Every line item must be mapped to exactly one of these 13 trade categories:
${TRADE_CATEGORIES.map((c) => `${c.id}. ${c.name}`).join('\n')}
Map demolition, excavation, earthworks and concrete to category 1. Map prelims, site establishment, safety, bins, scaffolding, cleaning and certification to category 13. Map plumbing fixtures and tapware to category 11.

For each line item return:
- trade_category_id: 1–13
- description: clear builder-level item name (include room/location where known)
- quantity: number or null if not determinable
- unit: "m2" | "lm" | "m3" | "each" | "lot" | "hrs" | "weeks" | null. PC allowances and provisional sums use quantity 1, unit "lot".
- rate: AUD ex GST unit rate (number), or null only if you genuinely cannot price it
- dimensions_string: the measurement evidence from the document, e.g. "12.5m × 8.4m" or "counted 14 on plan" — null if none
- confidence: 0–100 (100 = explicitly stated in document, 70–85 = measured/counted from drawings, 40–60 = inferred, <40 = guess)
- item_type: "measured" | "pc_allowance" | "provisional_sum"
- pricing_basis: "measured" (from stated values/measurements) | "inferred" (reasonably inferred from drawings) | "allowance" (allowance only, needs a quote)
- line_item_key: canonical snake_case key for rate lookup, e.g. "concrete_slab_m2", "wall_framing_lm", "downlight_install_each"
- notes: assumptions, exclusions, or what needs confirming — null if none

Respond with ONLY a JSON object, no markdown fences, no commentary:
{"document_type": string, "line_items": [ ... ]}`
}

// ─── Robust JSON parsing ──────────────────────────────────────────────────────

function parseExtractionJson(raw: string): ExtractedItem[] {
  let text = raw.trim()
  // Strip markdown fences if the model added them despite instructions
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) text = fenceMatch[1].trim()
  // Fall back to the outermost braces
  if (!text.startsWith('{')) {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) return []
    text = text.slice(start, end + 1)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }

  const items = (parsed as { line_items?: unknown[] }).line_items
  if (!Array.isArray(items)) return []

  const valid: ExtractedItem[] = []
  for (const entry of items) {
    if (typeof entry !== 'object' || entry === null) continue
    const it = entry as Record<string, unknown>
    const categoryId = Number(it.trade_category_id)
    const description = typeof it.description === 'string' ? it.description.trim() : ''
    if (!description || !Number.isInteger(categoryId) || categoryId < 1 || categoryId > 13) continue

    const itemType: ItemType =
      it.item_type === 'pc_allowance' || it.item_type === 'provisional_sum'
        ? it.item_type
        : 'measured'
    const pricingBasis: PricingBasis =
      it.pricing_basis === 'inferred' || it.pricing_basis === 'allowance'
        ? it.pricing_basis
        : itemType === 'measured'
          ? 'measured'
          : 'allowance'

    valid.push({
      trade_category_id: categoryId,
      description,
      quantity: typeof it.quantity === 'number' && Number.isFinite(it.quantity) ? it.quantity : null,
      unit: typeof it.unit === 'string' && it.unit ? it.unit : null,
      rate: typeof it.rate === 'number' && Number.isFinite(it.rate) ? it.rate : null,
      dimensions_string:
        typeof it.dimensions_string === 'string' && it.dimensions_string
          ? it.dimensions_string
          : null,
      confidence:
        typeof it.confidence === 'number' && Number.isFinite(it.confidence)
          ? Math.max(0, Math.min(100, Math.round(it.confidence)))
          : 0,
      item_type: itemType,
      pricing_basis: pricingBasis,
      line_item_key:
        typeof it.line_item_key === 'string' && it.line_item_key ? it.line_item_key : null,
      notes: typeof it.notes === 'string' && it.notes ? it.notes : null,
    })
  }
  return valid
}

// ─── Per-document extraction ──────────────────────────────────────────────────

const MAX_DOC_BYTES = 24 * 1024 * 1024 // keep each request comfortably under API limits

export async function extractItemsFromDocument(
  apiKey: string,
  doc: IntakeDocument,
  state: string
): Promise<{ items: ExtractedItem[]; skipped: string | null }> {
  // base64 is ~4/3 of raw size
  if (doc.base64.length > (MAX_DOC_BYTES * 4) / 3) {
    return { items: [], skipped: `${doc.filename} is too large to analyse (over 24MB)` }
  }

  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client = new Anthropic({ apiKey })

  const isPdf = doc.media_type === 'application/pdf'
  const contentBlock = isPdf
    ? {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: doc.base64 },
      }
    : {
        type: 'image',
        source: { type: 'base64', media_type: doc.media_type, data: doc.base64 },
      }

  const params = {
    model: ESTIMATE_MODEL,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    system: buildSystemPrompt(state),
    messages: [
      {
        role: 'user',
        content: [
          contentBlock,
          {
            type: 'text',
            text: `Document filename: ${doc.filename}\n\nExtract all builder-level estimate line items from this document.`,
          },
        ],
      },
    ],
  }

  // Stream to avoid HTTP timeouts on long structured output. The installed SDK
  // (0.24) predates document blocks and adaptive thinking in its types, so the
  // params object is passed through untyped — the API accepts them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = client.messages.stream(params as any)
  const finalMessage = await stream.finalMessage()

  const text = finalMessage.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')

  return { items: parseExtractionJson(text), skipped: null }
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
// Gate 1: measured/inferred item with no unit → unresolved assumption
// Gate 2: measured area/length quantity with no dimensional evidence → unresolved
// Gate 3: zero/negative quantity → auto-excluded
// Gate 4: very low confidence (<40) on a priced measured item → unresolved
// PC allowances and provisional sums are explicit allowances, not invented
// quantities — they are surfaced in the PC/provisional schedule instead.

const DIMENSIONAL_UNITS = new Set(['m2', 'sqm', 'm²', 'lm', 'm3', 'm³', 'm'])

export function applyValidationGates(items: ExtractedItem[]): {
  validated: ValidatedItem[]
  assumptions: AssumptionNote[]
} {
  const assumptions: AssumptionNote[] = []

  const validated = items.map((item): ValidatedItem => {
    let isAssumption = false
    let status: 'unresolved' | 'excluded' | null = null

    const isAllowance = item.item_type !== 'measured'

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
