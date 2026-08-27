// ─── WorkA Estimation Engine ───────────────────────────────────────────────────
// Resolves a rate for each extracted quote line item using the 5-tier rate
// hierarchy (first match wins):
//   Tier 1: builder_learned_rates      — auto-captured from accepted quotes
//   Tier 2: builder_rate_preferences   — manual builder override
//   Tier 3: builder_supplier_rates     — imported price lists
//   Tier 4: cost_rates                 — platform defaults, state-aware
//   Tier 5: network_rate_aggregates    — anonymised P50 across all builders
//
// Pricing is best-effort: a line item that cannot be matched to a rate keeps
// rate = null / total = null and is simply not counted in the quote total.

import type { SupabaseClient } from '@supabase/supabase-js'
// Relative, not the '@/*' alias used elsewhere — this file must resolve
// identically under plain `node --experimental-strip-types` (the dev
// scripts import it directly) and under Next.js/webpack. Same reasoning
// pipeline-logic.ts's own cross-runtime imports document.
import { tradeCategoryName } from './trade-taxonomy.ts'

export const DEFAULT_MARGIN_PCT = 18

// ─── GST & contingency — product decision, documented here as the single
// source of truth (pre-first-estimate remediation pass) ────────────────────
//
// quotes.gst_pct (default 10) and quotes.contingency_pct (default 8) exist
// in the schema (migration 014), whose own comment describes an intended
// "direct cost -> contingency -> margin -> GST" breakdown. Neither column
// has ever been read by any pricing or display code — every client-facing
// price has always been cost * (1 + margin_pct). Separately, the PDF export
// (app/api/quotes/[quoteId]/export-pdf/route.ts) already carries its own,
// independently-written footer: "All amounts in AUD excluding GST unless
// stated." That pre-existing disclaimer is the real signal of intended
// product behaviour, not the unused column defaults.
//
// DECISION: GST-exclusive, explicit and consistent everywhere.
//   Every client-facing total (QuoteView, PDF export, send-quote email
//   draft, the quote API's client_price, the job-activation contract value)
//   is cost * (1 + margin_pct) — UNCHANGED arithmetic — now labeled with
//   PRICE_BASIS_LABEL/CLIENT_PRICE_DISCLAIMER below on every one of those
//   surfaces, not just the PDF footer.
//   Rejected: auto-applying gst_pct to produce a GST-inclusive total. That
//   would change the literal number on WorkA's first-ever real quote,
//   introduces new arithmetic in exactly the calculation this remediation
//   pass exists to de-risk, and contradicts the disclaimer already shipped.
//   If GST-inclusive quoting is wanted later, that's a deliberate product
//   decision for a human to make, not something to infer from a default.
//
// DECISION: contingency_pct is NOT applied to pricing. Left in the schema
// (dropping the column is an unnecessary migration for what is really a
// documentation gap) but explicitly out of the pricing flow: silently
// baking an unexplained markup into a builder's first real quote is exactly
// the "confidently output a number nobody can explain" risk this pass
// exists to close. A real contingency feature needs its own builder-visible
// control (e.g. a labeled breakdown line), not an invisible multiplier —
// that is future product work, not something to add speculatively here.
export const PRICE_BASIS_LABEL = 'excl. GST'
export const CLIENT_PRICE_DISCLAIMER = 'All prices are in AUD and exclude GST.'

export type RateSource = 'learned' | 'preference' | 'supplier' | 'retail_baseline' | 'platform' | 'network'

export interface PriceableItem {
  trade_category_id: number
  description: string
  quantity: number | null
  unit: string | null
  /** Optional — when present, priceLineItems takes the MIN of this and any
   *  fallback tier's own confidence (weakest-link, same philosophy as
   *  computeQuoteTotals), so a low-confidence pricing tier can never make a
   *  quote look more certain than it is. */
  confidence?: number | null
}

export interface ResolvedRate {
  rate: number
  unit: string
  source: RateSource
  line_item_key: string
  /** Only set when source === 'retail_baseline' — the material/labour split
   *  that composed `rate`, so callers can populate quote_line_items'
   *  existing material_cost/labour_cost columns instead of only a blended
   *  total. */
  materialRate?: number
  materialSource?: string
  labourRate?: number
  /** When the resolved row was itself last set/imported/computed (builder_
   *  learned_rates.updated_at, builder_rate_preferences.set_at,
   *  builder_supplier_rates.imported_at, cost_rates.created_at,
   *  network_rate_aggregates.updated_at). Null for retail_baseline (already
   *  carries its own captured_at via materialSource's row) and category_rate
   *  (an in-memory average, no single source row). Observability only — a
   *  calibration-priority signal for the builder, never used to pick a tier. */
  rateDate?: string | null
}

// ─── Unit normalisation ───────────────────────────────────────────────────────

const UNIT_ALIASES: Record<string, string> = {
  'm2': 'm2', 'sqm': 'm2', 'm²': 'm2', 'sq m': 'm2', 'sq.m': 'm2',
  'square metres': 'm2', 'square meters': 'm2',
  'lm': 'lm', 'm': 'lm', 'lin m': 'lm', 'linear m': 'lm',
  'linear metres': 'lm', 'metres': 'lm', 'meters': 'lm',
  'm3': 'm3', 'm³': 'm3', 'cum': 'm3', 'cubic metres': 'm3', 'cubic meters': 'm3',
  'each': 'each', 'ea': 'each', 'no': 'each', 'no.': 'each', 'item': 'each',
  'items': 'each', 'unit': 'each', 'units': 'each', 'point': 'each', 'points': 'each',
  'lot': 'lot', 'ls': 'lot', 'lump sum': 'lot', 'allowance': 'lot',
  'week': 'weeks', 'weeks': 'weeks', 'wk': 'weeks', 'wks': 'weeks',
  'hour': 'hours', 'hours': 'hours', 'hr': 'hours', 'hrs': 'hours',
}

export function normalizeUnit(unit: string | null): string | null {
  if (!unit) return null
  const key = unit.trim().toLowerCase()
  return UNIT_ALIASES[key] ?? key
}

// ─── Description → line_item_key matching ─────────────────────────────────────

const STOP_WORDS = new Set([
  'and', 'the', 'of', 'to', 'for', 'with', 'a', 'an', 'in', 'on', 'per', 'inc', 'incl',
])

// Australian construction vocabulary — maps common trade slang and variants
// to the canonical token used in the platform rate catalogue. Applied after
// singularisation, so plural forms resolve too.
const TOKEN_SYNONYMS: Record<string, string> = {
  'colourbond': 'colorbond',
  'gyprock': 'plasterboard',
  'drywall': 'plasterboard',
  'plaster': 'plasterboard',
  'powerpoint': 'gpo',
  'outlet': 'gpo',
  'socket': 'gpo',
  'downlight': 'light',
  'excavate': 'excavation',
  'digging': 'excavation',
  'earthwork': 'excavation',
  'concreting': 'concrete',
  'painting': 'paint',
  'tiling': 'tile',
  'lino': 'vinyl',
  'linoleum': 'vinyl',
  'floorboard': 'timber',
  'hardwood': 'timber',
  'electric': 'electrical',
  'sparky': 'electrical',
  'kitchenette': 'kitchen',
  'robe': 'wardrobe',
  'guttering': 'gutter',
  'wc': 'toilet',
  'loo': 'toilet',
  'lavatory': 'toilet',
  'bricklaying': 'brick',
  'brickwork': 'brick',
  'scaffold': 'scaffolding',
}

export function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (raw.length < 2 || STOP_WORDS.has(raw)) continue
    // Crude singularisation so "tiles" matches "tile", "gutters" matches "gutter"
    const singular = raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw
    const canonical = TOKEN_SYNONYMS[singular] ?? singular
    out.add(canonical)
  }
  return out
}

export interface CatalogueEntry {
  line_item_key: string
  trade_category_id: number
  description: string
  unit: string
  tokens: Set<string>
}

export type MatchStrength = 'exact' | 'normalized'

export interface CatalogueMatch {
  key: string
  strength: MatchStrength
}

/**
 * Match a line item description to a catalogue line_item_key.
 * Requires same trade category and a compatible unit; scores by token overlap.
 *
 * strength: 'exact' when every one of the catalogue entry's tokens is present
 * in the item's own tokens (branded/verbose descriptions routinely contain
 * the catalogue's plain-language term plus extra product detail — e.g.
 * "VELUX Solar Powered Skylight" fully contains a "skylight" entry's tokens
 * even though the strings don't match verbatim). 'normalized' is a partial
 * overlap — real signal (via TOKEN_SYNONYMS/singularisation), but weaker:
 * some of the catalogue entry's own concept isn't accounted for in the item
 * description, so this is a plausible match, not a confirmed one.
 */
export function matchLineItemKey(
  item: PriceableItem,
  catalogue: CatalogueEntry[]
): CatalogueMatch | null {
  const itemTokens = tokenize(item.description)
  const itemUnit = normalizeUnit(item.unit)
  if (itemTokens.size === 0) return null

  let bestKey: string | null = null
  let bestScore = 0
  let bestEntryTokenCount = 0

  for (const entry of catalogue) {
    if (entry.trade_category_id !== item.trade_category_id) continue
    // A rate in a different unit cannot price this quantity
    if (itemUnit && normalizeUnit(entry.unit) !== itemUnit) continue

    let score = 0
    entry.tokens.forEach((token) => {
      if (itemTokens.has(token)) score++
    })
    if (score > bestScore) {
      bestScore = score
      bestKey = entry.line_item_key
      bestEntryTokenCount = entry.tokens.size
    }
  }

  if (bestScore < 1 || !bestKey) return null
  const strength: MatchStrength = bestEntryTokenCount > 0 && bestScore >= bestEntryTokenCount ? 'exact' : 'normalized'
  return { key: bestKey, strength }
}

// ─── Rate resolution (5-tier hierarchy) ───────────────────────────────────────

// A learned rate needs at least this many contributing quotes before Tier 1
// trusts it over the platform default. With no threshold, the very first
// activation set the learned rate outright (upsert_learned_rate seeds the
// running average from sample 1) and immediately outranked every other tier —
// one rushed job, favor price, or fat-fingered rate permanently became that
// builder's authoritative price with nothing to dilute it. Below the
// threshold the sample is still captured (the average keeps building); it
// just doesn't OVERRIDE anything until a second independent quote agrees
// it's real.
export const MIN_LEARNED_RATE_SAMPLES = 2

interface RateRow {
  line_item_key: string
  rate: number
  unit: string
  sample_count?: number | null
  /** Tier's own timestamp column (builder_learned_rates.updated_at,
   *  builder_rate_preferences.set_at, builder_supplier_rates.imported_at) —
   *  carried through to ResolvedRate.rateDate purely for observability
   *  (pricing_basis' "last updated" line below), never used in matching. */
  rate_date?: string | null
}

interface StateRateRow extends RateRow {
  state: string | null
  trade_category_id: number
}

interface NetworkRateRow {
  line_item_key: string
  state: string | null
  rate_p50: number | null
  updated_at?: string | null
}

interface MaterialPriceRow {
  line_item_key: string
  trade_category_id: number
  unit: string
  unit_price: number
  source: string
  captured_at: string
  region: string | null
}

interface LabourBenchmarkRow {
  trade_category_id: number
  unit: string
  labour_rate: number
  region: string | null
}

export interface RateContext {
  learned: RateRow[]
  preferences: RateRow[]
  supplier: RateRow[]
  retailMaterial: MaterialPriceRow[]
  labourBenchmarks: LabourBenchmarkRow[]
  platform: StateRateRow[]
  network: NetworkRateRow[]
  catalogue: CatalogueEntry[]
  builderState: string | null
}

interface PlatformCatalogueRow {
  line_item_key: string
  trade_category_id: number
  description: string
  unit: string
  state: string | null
}

interface RetailCatalogueRow {
  line_item_key: string
  trade_category_id: number
  brand: string | null
  product_name: string
  unit: string
}

/**
 * THE single shared catalogue-loading path — every place in this file that
 * needs to fuzzy-match a description to a line_item_key (pricing resolution,
 * quote-approval learning, actual-cost learning) must call this, not build
 * its own query. Before this existed, captureLearnedRates()/
 * applyActualCostLearning() queried cost_rates only, while priceLineItems()
 * (via loadRateContext) queried cost_rates + market_material_prices — a real,
 * confirmed defect: the same description could resolve to a DIFFERENT
 * line_item_key at pricing time than at learning time, corrupting the
 * learned average under the wrong key. Fixed by making this the one place
 * the catalogue is assembled, called from all three sites below.
 *
 * Exported (Round 10 reliability audit) so app/api/rates/import/route.ts can
 * resolve an imported supplier description against this SAME catalogue
 * before persisting a line_item_key — a supplier rate stored under any key
 * other than a real catalogue entry's own key is structurally unreachable by
 * resolveRateForKey's Tier 3 (exact-key match only), since matchLineItemKey
 * only ever returns keys drawn from this catalogue. No behavior change here;
 * visibility only.
 */
export async function loadPricingCatalogue(supabase: SupabaseClient): Promise<CatalogueEntry[]> {
  const [platformRes, retailRes] = await Promise.all([
    supabase.from('cost_rates').select('line_item_key, trade_category_id, description, unit, state').is('state', null),
    supabase.from('market_material_prices').select('line_item_key, trade_category_id, brand, product_name, unit'),
  ])

  const platform = (platformRes.data ?? []) as PlatformCatalogueRow[]
  const retail = (retailRes.data ?? []) as RetailCatalogueRow[]

  // A brand/product-specific retail entry naturally outscores a generic
  // cost_rates entry when a description names the product (more of the
  // entry's own tokens matched), by the SAME token-overlap scoring
  // matchLineItemKey already does. No matcher change needed.
  return [
    ...platform.map((row) => ({
      line_item_key: row.line_item_key,
      trade_category_id: row.trade_category_id,
      description: row.description,
      unit: row.unit,
      tokens: tokenize(row.description),
    })),
    ...retail.map((row) => ({
      line_item_key: row.line_item_key,
      trade_category_id: row.trade_category_id,
      description: [row.brand, row.product_name].filter(Boolean).join(' '),
      unit: row.unit,
      tokens: tokenize([row.brand, row.product_name].filter(Boolean).join(' ')),
    })),
  ]
}

async function loadRateContext(
  supabase: SupabaseClient,
  builderId: string,
  builderState: string | null
): Promise<RateContext> {
  const stateFilter = builderState ? `state.is.null,state.eq.${builderState}` : 'state.is.null'
  const regionFilter = builderState ? `region.is.null,region.eq.${builderState}` : 'region.is.null'

  const [learnedRes, prefRes, supplierRes, platformRes, networkRes, retailRes, labourRes, catalogue] = await Promise.all([
    supabase.from('builder_learned_rates').select('line_item_key, rate, unit, sample_count, updated_at').eq('builder_id', builderId),
    supabase.from('builder_rate_preferences').select('line_item_key, rate, unit, set_at').eq('builder_id', builderId),
    supabase.from('builder_supplier_rates').select('line_item_key, rate, unit, imported_at').eq('builder_id', builderId),
    supabase.from('cost_rates').select('line_item_key, trade_category_id, description, unit, rate, state, created_at').or(stateFilter),
    supabase.from('network_rate_aggregates').select('line_item_key, state, rate_p50, updated_at').or(stateFilter),
    supabase.from('market_material_prices').select('line_item_key, trade_category_id, brand, product_name, unit, unit_price, source, captured_at, region').or(regionFilter),
    supabase.from('labour_rate_benchmarks').select('trade_category_id, unit, labour_rate, region').or(regionFilter),
    loadPricingCatalogue(supabase),
  ])

  // Each tier's own timestamp column has a different name (set_at/imported_at/
  // updated_at/created_at) — normalized here, once, to the shared `rate_date`
  // field RateRow/StateRateRow/NetworkRateRow expose, so resolveRateForKey
  // doesn't need to know which column name belongs to which tier.
  const learned = ((learnedRes.data ?? []) as Array<RateRow & { updated_at?: string | null }>)
    .map((r) => ({ ...r, rate_date: r.updated_at ?? null }))
  const preferences = ((prefRes.data ?? []) as Array<RateRow & { set_at?: string | null }>)
    .map((r) => ({ ...r, rate_date: r.set_at ?? null }))
  const supplier = ((supplierRes.data ?? []) as Array<RateRow & { imported_at?: string | null }>)
    .map((r) => ({ ...r, rate_date: r.imported_at ?? null }))
  const platform = ((platformRes.data ?? []) as Array<StateRateRow & { description: string; created_at?: string | null }>)
    .map((r) => ({ ...r, rate_date: r.created_at ?? null }))
  const network = ((networkRes.data ?? []) as Array<NetworkRateRow & { updated_at?: string | null }>)
  const retail = (retailRes.data ?? []) as Array<MaterialPriceRow & { brand: string | null; product_name: string }>

  return {
    learned,
    preferences,
    supplier,
    retailMaterial: retail,
    labourBenchmarks: (labourRes.data ?? []) as LabourBenchmarkRow[],
    platform,
    network,
    catalogue,
    builderState,
  }
}

export function resolveRateForKey(
  key: string,
  itemUnit: string | null,
  ctx: RateContext
): ResolvedRate | null {
  const unitMatches = (rateUnit: string) =>
    !itemUnit || normalizeUnit(rateUnit) === itemUnit

  // Tier 1: learned — only once enough independent quotes agree (see
  // MIN_LEARNED_RATE_SAMPLES). A single-sample "learned" rate falls through
  // to the tiers below instead of overriding them.
  const learned = ctx.learned.find(
    (r) => r.line_item_key === key && unitMatches(r.unit) && (r.sample_count ?? 1) >= MIN_LEARNED_RATE_SAMPLES
  )
  if (learned) return { rate: learned.rate, unit: learned.unit, source: 'learned', line_item_key: key, rateDate: learned.rate_date ?? null }

  // Tier 2: preference
  const pref = ctx.preferences.find((r) => r.line_item_key === key && unitMatches(r.unit))
  if (pref) return { rate: pref.rate, unit: pref.unit, source: 'preference', line_item_key: key, rateDate: pref.rate_date ?? null }

  // Tier 3: supplier (cheapest compatible rate across imported lists)
  const supplierRates = ctx.supplier.filter((r) => r.line_item_key === key && unitMatches(r.unit))
  if (supplierRates.length > 0) {
    const cheapest = supplierRates.reduce((a, b) => (b.rate < a.rate ? b : a))
    return { rate: cheapest.rate, unit: cheapest.unit, source: 'supplier', line_item_key: key, rateDate: cheapest.rate_date ?? null }
  }

  // Tier 3.5: retail/material baseline — a real material price is never
  // treated as an installed rate on its own. Only resolves when BOTH a
  // matching retail material price AND a labour benchmark for that trade
  // exist; otherwise falls through to Tier 4 exactly as before this tier
  // existed. See migration 083 / the pricing-intelligence design doc.
  const retail = ctx.retailMaterial.find((r) => r.line_item_key === key && unitMatches(r.unit))
  if (retail) {
    const labourCandidates = ctx.labourBenchmarks.filter(
      (l) => l.trade_category_id === retail.trade_category_id && unitMatches(l.unit)
    )
    const labour =
      labourCandidates.find((l) => l.region !== null && l.region === ctx.builderState) ??
      labourCandidates.find((l) => l.region === null)
    if (labour) {
      return {
        rate: round2(retail.unit_price + labour.labour_rate),
        unit: retail.unit,
        source: 'retail_baseline',
        line_item_key: key,
        materialRate: retail.unit_price,
        materialSource: retail.source,
        labourRate: labour.labour_rate,
        rateDate: retail.captured_at ?? null,
      }
    }
  }

  // Tier 4: platform defaults — state-specific first, national fallback
  const platformRates = ctx.platform.filter((r) => r.line_item_key === key && unitMatches(r.unit))
  const stateRate = platformRates.find((r) => r.state !== null && r.state === ctx.builderState)
  const nationalRate = platformRates.find((r) => r.state === null)
  const platformRate = stateRate ?? nationalRate
  if (platformRate) {
    return { rate: platformRate.rate, unit: platformRate.unit, source: 'platform', line_item_key: key, rateDate: platformRate.rate_date ?? null }
  }

  // Tier 5: network P50 — state-specific first, national fallback
  const networkRates = ctx.network.filter((r) => r.line_item_key === key && r.rate_p50 !== null)
  const networkRate =
    networkRates.find((r) => r.state !== null && r.state === ctx.builderState) ??
    networkRates.find((r) => r.state === null)
  if (networkRate && networkRate.rate_p50 !== null) {
    return { rate: networkRate.rate_p50, unit: itemUnit ?? 'each', source: 'network', line_item_key: key, rateDate: networkRate.updated_at ?? null }
  }

  return null
}

/**
 * Category fallback (tier 3 of the measured-item fallback chain, migration
 * 072): when no catalogue entry matches this item's description at all —
 * confirmed on a real quote to be common for branded/specific products
 * (skylights, floor wastes, mirrors) the 630-row cost_rates seed simply has
 * no entry for, at any match strength — fall back to the average of every
 * national platform rate in the same trade + compatible unit. A rough
 * per-unit proxy, not a specific-item price, which is exactly why it's a
 * distinct, lower-confidence pricing_source rather than being folded into
 * cost_rates_normalized.
 */
export function resolveCategoryFallbackRate(
  tradeCategoryId: number,
  itemUnit: string | null,
  ctx: RateContext
): { rate: number; sampleCount: number } | null {
  if (!itemUnit) return null
  const candidates = ctx.platform.filter(
    (r) => r.state === null && r.trade_category_id === tradeCategoryId && normalizeUnit(r.unit) === itemUnit
  )
  if (candidates.length === 0) return null
  const avg = candidates.reduce((sum, r) => sum + r.rate, 0) / candidates.length
  return { rate: round2(avg), sampleCount: candidates.length }
}

// ─── AI measured-rate fallback (tier 4, migration 072) ─────────────────────
// Only reached once exact/normalized/category matching have all failed. This
// is deliberately distinct from an AI Allowance: an allowance is for scope
// with NO measurable quantity ("I need a reasonable budget figure"); this is
// for scope that WAS measured — a real quantity and unit already exist — but
// nothing in the rate hierarchy could price it. The prompt is scoped tightly
// to proposing a $/unit RATE for the given quantity/unit; it is never asked
// for (and the tool schema has no field for) a quantity — that's already
// fixed by Stage 6, and this function has no business revising it.

/**
 * Pure gating predicate, extracted so the "when is AI allowed to propose a
 * measured rate" rule is independently testable without a live Claude/DB
 * call. An item only reaches this tier if every earlier tier already failed
 * to match it AND it has a genuine quantity + unit — this is what keeps the
 * distinction from AI Allowance real: no quantity means no eligibility here,
 * full stop, regardless of how clear the description is.
 */
export function isEligibleForAiMeasuredRate(item: { matched: boolean; unit: string | null; quantity: number | null }): boolean {
  if (item.matched) return false
  if (!item.unit) return false
  if (item.quantity === null || item.quantity <= 0) return false
  return true
}

interface AiRateCandidate {
  index: number
  description: string
  tradeName: string
  unit: string
  quantity: number | null
}

interface AiRateEstimate {
  rate: number | null
  reasoning: string | null
  confidence: number | null
}

const AI_RATE_TOOL = {
  name: 'estimate_measured_rates',
  description: 'Propose a $/unit cost rate for each line item — never a quantity, which is already fixed.',
  input_schema: {
    type: 'object' as const,
    properties: {
      estimates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'The item index from the input list.' },
            rate: { type: ['number', 'null'], description: 'Your best-estimate AUD $/unit rate (supply + install) for this exact item and unit. Null only if you genuinely cannot estimate any reasonable rate for this description.' },
            reasoning: { type: 'string', description: 'One sentence — what this rate is based on (e.g. comparable products/trade norms).' },
            confidence: { type: 'integer', minimum: 0, maximum: 100, description: 'Confidence in this rate specifically. This is a judgment call standing in for a missing rate-table match, so should rarely exceed 60.' },
          },
          required: ['index', 'rate', 'reasoning', 'confidence'],
        },
      },
    },
    required: ['estimates'],
  },
}

// Caps how many AI-measured-rate candidates one resolveAiMeasuredRates call
// covers — see the call site's own comment (priceLineItems, Tier 4) for the
// production incident (HTTP 502 on a 220-line-item quote) this closes.
const MAX_AI_MEASURED_RATE_CANDIDATES_PER_PASS = 40

/**
 * Batches every item that reached this tier into one Claude call (mirrors
 * Stage 6's own batching philosophy — one call, not N). Routed through the
 * shared spend-protected gateway (ai-gateway.ts) like every other Anthropic
 * call in the codebase; never called directly. Best-effort: any failure
 * (missing key, network, malformed response) returns an empty map, leaving
 * those items to fall through to 'unresolved' — this must never throw and
 * break the pricing pass it's a fallback tier within.
 */
async function resolveAiMeasuredRates(
  supabase: SupabaseClient,
  builderId: string,
  candidates: AiRateCandidate[]
): Promise<Map<number, AiRateEstimate>> {
  const results = new Map<number, AiRateEstimate>()
  if (candidates.length === 0) return results

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) return results

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    // Relative, same cross-runtime reason as the trade-taxonomy import above.
    const { guardedClaudeCall } = await import('../supabase/functions/smooth-responder/ai-gateway.ts')
    const client = new Anthropic({ apiKey: anthropicKey })

    const itemsBlock = candidates
      .map((c) => `${c.index}. [${c.tradeName}] ${c.description} — quantity: ${c.quantity ?? 'unknown'} ${c.unit}`)
      .join('\n')

    const prompt = `You are a senior Australian residential quantity surveyor. Each item below has an already-confirmed quantity and unit — do NOT question or revise them. None of these matched the platform's cost rate catalogue (often because they're specific branded products), so propose your own best-estimate $/unit rate (supply + install, AUD, excluding margin and GST) for each, based on trade norms and comparable products.\n\n${itemsBlock}\n\nUse the estimate_measured_rates tool.`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { response } = await guardedClaudeCall<any>(
      { supabase, attribution: { kind: 'builder', builderId }, callSite: 'measured_rate_fallback', model: 'claude-sonnet-4-6' },
      (signal) => client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
        tools: [AI_RATE_TOOL],
        tool_choice: { type: 'tool', name: AI_RATE_TOOL.name },
      }, { signal }),
      { timeoutMs: 60_000, maxRetries: 1, label: 'measured_rate_fallback' }
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolUse = response.content?.find((b: any) => b.type === 'tool_use')
    const estimates = (toolUse?.input?.estimates ?? []) as Array<{ index: number; rate: number | null; reasoning: string; confidence: number }>
    for (const e of estimates) {
      if (typeof e.index !== 'number') continue
      results.set(e.index, {
        rate: typeof e.rate === 'number' && isFinite(e.rate) && e.rate > 0 ? e.rate : null,
        reasoning: e.reasoning ?? null,
        confidence: typeof e.confidence === 'number' ? e.confidence : null,
      })
    }
  } catch (err) {
    console.error('resolveAiMeasuredRates failed:', err)
  }
  return results
}

// ─── Public API ───────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Human-readable "as of" suffix for a rate's own last-updated/set/imported/
 *  captured timestamp — observability only, appended to pricing_basis so a
 *  builder can see how stale a resolved rate is without a new column or UI. */
function rateDateSuffix(rateDate: string | null | undefined): string {
  if (!rateDate) return ''
  const d = new Date(rateDate)
  if (isNaN(d.getTime())) return ''
  return ` (rate set ${d.toISOString().slice(0, 10)})`
}

const PRICING_SOURCE_LABEL: Record<RateSource, string> = {
  learned: "Builder's own learned rate from past accepted quotes",
  preference: 'Builder rate preference (manual override)',
  supplier: 'Imported supplier/subcontractor price list',
  retail_baseline: 'Retail material price + labour benchmark',
  platform: 'Platform default cost rate (industry benchmark)',
  network: 'Anonymised network median rate across builders',
}

/**
 * Client-facing price: internal cost marked up by the builder's margin.
 * Everything a client sees (quote view, PDF, email) must use this — raw cost
 * rates are internal data and never leave the builder's screen unmarked.
 */
export function applyMargin(cost: number, marginPct: number): number {
  return round2(cost * (1 + marginPct / 100))
}

export interface SellPriceableItem {
  total: number | null
  /** quote_line_items.margin_pct — a 0-1 fraction (0.15 for a normal measured/
   *  document/allowance line, 0 for a provisional sum, enforced by the
   *  trg_ps_margin DB trigger, migration 012). Null defaults to 0 (never
   *  invents a margin the row doesn't actually carry). */
  margin_pct: number | null
  assumption_status: string | null
}

/**
 * Sell price for ONE line item — cost marked up by THIS item's own
 * margin_pct, never a quote-level blanket rate. This is the financial
 * source-of-truth calculation at the line level; applyMargin itself is
 * unchanged (still a plain cost*(1+pct/100) primitive), this just supplies
 * the correct, item-specific percentage instead of quote.margin_pct.
 */
export function calculateSellTotal(item: { total: number | null; margin_pct: number | null }): number | null {
  if (item.total === null) return null
  return applyMargin(item.total, (item.margin_pct ?? 0) * 100)
}

/**
 * THE single canonical client price calculation. Every client-facing
 * financial surface (quote summary API, PDF export, send-quote email draft,
 * job activation / invoice contract value) must derive its total from this
 * function — never from `applyMargin(quote.total_cost, quote.margin_pct)`,
 * which blanket-applies one quote-level percentage to the whole cost basis
 * and ignores each item's own margin_pct. That formula is what silently
 * marked up provisional-sum items (margin_pct = 0 by design) by the full
 * blanket rate, and let a quote's header total disagree with the sum of the
 * same line items QuoteView displays beneath it — the financial correctness
 * audit this function closes for the full incident writeup. Excluded items
 * never contribute, matching computeQuoteTotals' own definition of
 * "included."
 */
export function calculateClientPrice(items: SellPriceableItem[]): number {
  const included = items.filter((i) => i.assumption_status !== 'excluded')
  const sum = included.reduce((acc, i) => acc + (calculateSellTotal(i) ?? 0), 0)
  return round2(sum)
}

export type MeasuredPricingSource = 'document_selection' | 'cost_rates_exact' | 'cost_rates_normalized' | 'builder_rate' | 'network_rate' | 'category_rate' | 'ai_measured_rate' | 'retail_baseline' | 'unresolved'

// ─── Document-confirmed selection pricing (Tier 0 — outranks every other
// tier below) ───────────────────────────────────────────────────────────────
//
// Stage 1/2 already extracts named products from FF&E/materials/finishes
// schedules as project_facts (category 'fixtures' | 'materials'), encoding
// the product's price (or "$0.00 / not yet priced") directly into the
// fact's free-text `value` — there is no structured price column, by
// design (see the docSystemPrompt comment this mirrors). This is the one
// place that free text is parsed back into a number, purely so a builder's
// own confirmed selection can outrank a generic catalogue/AI guess for the
// SAME physical item — never used to invent a price, only to recover one
// that's already been extracted and confirmed.

export interface DocumentSelectionFact {
  fact_id: string
  category: string
  key: string
  value: string
  confidence: number | null
  source_document_id: string | null
  created_at: string | null
}

export interface ExtractedSelectionPrice {
  price: number
  raw: string
}

// A selection schedule explicitly marking a row "$0.00" or "not yet priced"
// is evidence the item is design-intent-only (see the Stage 1/2 prompt this
// mirrors) — that is NOT evidence the item costs nothing, and must never be
// read as a confirmed zero price.
const NOT_YET_PRICED_PATTERN = /\$\s?0(\.00)?\b|\bnot yet priced\b|\btbc\b|\bt\.b\.c\b/i

/** Recovers a confirmed AUD figure from a project_facts.value free-text
 *  string (e.g. `"Toto Neorest smart toilet suite, ensuite, $8,500"`), or
 *  null if the value contains no usable price — including the explicit
 *  "not yet priced" case above, which must fall through to the normal
 *  pricing chain exactly like any other unpriced item. */
export function extractSelectionPrice(value: string): ExtractedSelectionPrice | null {
  if (!value) return null
  if (NOT_YET_PRICED_PATTERN.test(value)) return null
  const match = value.match(/\$\s?([\d,]+(?:\.\d{1,2})?)/)
  if (!match) return null
  const price = Number(match[1].replace(/,/g, ''))
  if (!isFinite(price) || price <= 0) return null
  return { price, raw: match[0] }
}

export interface DocumentSelectionMatch {
  fact: DocumentSelectionFact
  price: number
  score: number
}

// Requires at least 2 shared meaningful tokens between the line item's own
// description and the fact's key+value — a deliberately conservative bar
// (matchLineItemKey's catalogue matching accepts a single strong token) so a
// short, generic line item description can't accidentally claim a highly
// specific named-product fact's price. Ties broken by whichever fact has
// more shared tokens (a closer textual match), not by price or recency.
const MIN_SELECTION_MATCH_TOKENS = 2

/**
 * Best-matching document selection for ONE item, considered in isolation.
 * Confirmed on a real project during validation to be insufficient on its
 * own: a shared category subtotal fact whose value repeats generic words
 * ("5 bathrooms", "floor", "basin") that legitimately also appear in OTHER,
 * unrelated line items in the same bathroom scope (shower screens, wet-area
 * tiling) let three different items all independently "win" a match against
 * the SAME fact — each charging the full confirmed total, quadrupling one
 * real $27,043 figure into four. Calling this per-item, independently, is
 * therefore never safe on its own; always go through assignDocumentSelections
 * below, which enforces one fact -> at most one item globally. Exported
 * (and still used that way in tests) purely as the per-pair scoring
 * primitive, not as something priceLineItems calls directly any more.
 */
export function matchDocumentSelection(
  item: { description: string },
  facts: DocumentSelectionFact[]
): DocumentSelectionMatch | null {
  const itemTokens = tokenize(item.description)
  if (itemTokens.size === 0) return null
  let best: DocumentSelectionMatch | null = null
  let bestOverlap = 0
  for (const fact of facts) {
    if (fact.category !== 'fixtures' && fact.category !== 'materials') continue
    const priced = extractSelectionPrice(fact.value)
    if (!priced) continue
    const factTokens = tokenize(`${fact.key} ${fact.value}`)
    let overlap = 0
    for (const t of Array.from(itemTokens)) {
      if (factTokens.has(t)) overlap++
    }
    if (overlap < MIN_SELECTION_MATCH_TOKENS) continue
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = { fact, price: priced.price, score: overlap }
    }
  }
  return best
}

/**
 * Assigns document selections to line items GLOBALLY, one-to-one — the fix
 * for the double/triple-counting failure mode described above. Every
 * (item, matching fact) candidate pair is scored via matchDocumentSelection,
 * then claimed greedily by descending score: the single best-matching item
 * for a given fact wins it, and that fact is then unavailable to every other
 * item, however well it might otherwise have scored. A real confirmed price
 * can only ever be spent once. Returns a Map from the item's index in the
 * input array to its winning match.
 */
export function assignDocumentSelections<T extends { description: string }>(
  items: T[],
  facts: DocumentSelectionFact[]
): Map<number, DocumentSelectionMatch> {
  const candidates: Array<{ itemIndex: number; match: DocumentSelectionMatch }> = []
  items.forEach((item, itemIndex) => {
    const match = matchDocumentSelection(item, facts)
    if (match) candidates.push({ itemIndex, match })
  })
  candidates.sort((a, b) => b.match.score - a.match.score)
  const claimedFacts = new Set<string>()
  const assignment = new Map<number, DocumentSelectionMatch>()
  for (const c of candidates) {
    if (claimedFacts.has(c.match.fact.fact_id)) continue
    claimedFacts.add(c.match.fact.fact_id)
    assignment.set(c.itemIndex, c.match)
  }
  return assignment
}

function documentSelectionBasis(match: DocumentSelectionMatch): string {
  const dateStr = match.fact.created_at ? new Date(match.fact.created_at).toISOString().slice(0, 10) : 'unknown date'
  const sourceStr = match.fact.source_document_id ? `source document ${match.fact.source_document_id}` : 'source document unrecorded'
  return `Document-confirmed selection: "${match.fact.value}" (fact ${match.fact.fact_id}, ${sourceStr}, confidence ${match.fact.confidence ?? 'n/a'}%, extracted ${dateStr}).`
}

export interface PricedItemResult {
  rate: number | null
  total: number | null
  pricing_source: MeasuredPricingSource | null
  pricing_basis: string | null
  confidence: number | null
  /** Only ever set when pricing_source === 'retail_baseline' — populates
   *  quote_line_items' existing material_cost/labour_cost columns, which no
   *  other pricing_source writes to. */
  material_cost?: number | null
  labour_cost?: number | null
}

const RATE_SOURCE_TO_PRICING_SOURCE: Record<RateSource, MeasuredPricingSource> = {
  learned: 'builder_rate', preference: 'builder_rate', supplier: 'builder_rate',
  retail_baseline: 'retail_baseline',
  platform: 'cost_rates_exact', // overridden to cost_rates_normalized below when the match was partial
  network: 'network_rate',
}

/**
 * Price a batch of extracted line items via the measured-item fallback
 * chain (migration 072):
 *   document-confirmed selection (Tier 0, migration TBD) ->
 *   exact cost_rates match -> normalized cost_rates match ->
 *   same-trade/unit category average -> AI measured-rate estimate ->
 *   unresolved
 * Returns each item with rate/total AND its pricing_source/pricing_basis/
 * confidence filled in — never throws, never invents a quantity (only ever
 * proposes a $/unit RATE for a quantity that already exists).
 *
 * documentSelections (optional, default none — existing callers are
 * unaffected until they opt in): already-fetched project_facts rows
 * (category 'fixtures'/'materials') for this job. A matching fact's price
 * ALWAYS wins over every tier below, including an existing catalogue exact
 * match — a builder's own confirmed selection outranks a generic rate for
 * the same physical item, never the other way round. The matched price is
 * treated as an already-resolved TOTAL for the line item as scoped (a
 * schedule's printed figure is a category/item total, not a $/unit rate to
 * multiply by quantity again) — rate is left null, mirroring how Stage 6
 * already treats a document-priced BOQ line and an AI Allowance lump sum.
 */
export async function priceLineItems<T extends PriceableItem>(
  supabase: SupabaseClient,
  builderId: string,
  builderState: string | null,
  items: T[],
  documentSelections: DocumentSelectionFact[] = []
): Promise<Array<Omit<T, 'confidence'> & PricedItemResult>> {
  let ctx: RateContext
  try {
    ctx = await loadRateContext(supabase, builderId, builderState)
  } catch (err) {
    console.error('priceLineItems: failed to load rate context', err)
    return items.map((item) => ({ ...item, rate: null, total: null, pricing_source: null, pricing_basis: null, confidence: item.confidence ?? null }))
  }

  const withMinConfidence = (item: T, tierConfidence: number | null): number | null => {
    if (item.confidence == null) return tierConfidence
    if (tierConfidence == null) return item.confidence
    return Math.min(item.confidence, tierConfidence)
  }

  // Tier 0: document-confirmed selection — checked first, before any unit
  // check, since a schedule's confirmed total already stands on its own
  // (the same reasoning Stage 6 already applies to a document-priced BOQ
  // line or an AI Allowance lump sum). Only items WITHOUT a match fall
  // through to Tier 1-3 below.
  //
  // Assigned GLOBALLY (assignDocumentSelections), not per item — confirmed
  // during production validation to be necessary, not defensive: a single
  // category-subtotal fact whose value repeats generic bathroom vocabulary
  // ("5 bathrooms", "floor", "basin") independently "matched" three
  // unrelated line items (shower screens, wet-area tiling, floor/basin
  // wastes) against the SAME tapware fact when matched per item, each
  // claiming the full confirmed total — one real $27,043 figure counted up
  // to four times. Global one-to-one assignment means a confirmed price can
  // only ever be spent once, on its single best-matching item.
  const documentAssignment = documentSelections.length > 0 ? assignDocumentSelections(items, documentSelections) : new Map<number, DocumentSelectionMatch>()
  const afterDocumentSelection = items.map((item, index) => ({ item, docMatch: documentAssignment.get(index) ?? null }))

  // Tier 1-3: exact / normalized cost_rates + the existing 5-tier hierarchy
  // (learned/preference/supplier/platform/network), run synchronously first
  // since these are cheap DB lookups with no external call.
  const afterCatalogue = afterDocumentSelection.map(({ item, docMatch }) => {
    if (docMatch) {
      return {
        item, rate: null as number | null, total: docMatch.price,
        pricing_source: 'document_selection' as MeasuredPricingSource,
        pricing_basis: documentSelectionBasis(docMatch),
        material_cost: null as number | null, labour_cost: null as number | null,
        matched: true, _docConfidence: docMatch.fact.confidence,
      }
    }
    // No unit means the quantity cannot be safely priced — the builder must
    // resolve the assumption first (never invent quantities)
    if (!item.unit) {
      return { item, rate: null as number | null, total: null as number | null, pricing_source: null as MeasuredPricingSource | null, pricing_basis: null as string | null, material_cost: null as number | null, labour_cost: null as number | null, matched: false }
    }

    const match = matchLineItemKey(item, ctx.catalogue)
    const resolved = match ? resolveRateForKey(match.key, normalizeUnit(item.unit), ctx) : null

    if (!resolved) {
      return { item, rate: null, total: null, pricing_source: null, pricing_basis: null, material_cost: null, labour_cost: null, matched: false }
    }

    const pricingSource: MeasuredPricingSource =
      resolved.source === 'platform' && match?.strength === 'normalized'
        ? 'cost_rates_normalized'
        : RATE_SOURCE_TO_PRICING_SOURCE[resolved.source]

    const rate = resolved.rate
    const total = item.quantity !== null && item.quantity > 0 ? round2(item.quantity * rate) : null
    const pricingBasis = resolved.source === 'retail_baseline'
      ? `Material $${resolved.materialRate?.toFixed(2)}/${resolved.unit} (${resolved.materialSource}) + trade labour benchmark $${resolved.labourRate?.toFixed(2)}/${resolved.unit}.${rateDateSuffix(resolved.rateDate)}`
      : `${PRICING_SOURCE_LABEL[resolved.source]}${match?.strength === 'normalized' ? ' — matched via a normalized (fuzzy) description match, not exact' : ''}.${rateDateSuffix(resolved.rateDate)}`
    const materialCost = resolved.source === 'retail_baseline' && item.quantity !== null && item.quantity > 0 && resolved.materialRate !== undefined
      ? round2(item.quantity * resolved.materialRate) : null
    const labourCost = resolved.source === 'retail_baseline' && item.quantity !== null && item.quantity > 0 && resolved.labourRate !== undefined
      ? round2(item.quantity * resolved.labourRate) : null
    return { item, rate, total, pricing_source: pricingSource, pricing_basis: pricingBasis, material_cost: materialCost, labour_cost: labourCost, matched: true }
  })

  // Tier 3b: category fallback — same trade, same unit, no item-specific
  // match required. Cheap (in-memory average over already-loaded rates), no
  // external call, so still run synchronously before the AI tier.
  const afterCategory = afterCatalogue.map((r) => {
    if (r.matched || !r.item.unit) return r
    const fallback = resolveCategoryFallbackRate(r.item.trade_category_id, normalizeUnit(r.item.unit), ctx)
    if (!fallback) return r
    const total = r.item.quantity !== null && r.item.quantity > 0 ? round2(r.item.quantity * fallback.rate) : null
    const tradeName = tradeCategoryName(r.item.trade_category_id)
    return {
      ...r,
      rate: fallback.rate, total,
      pricing_source: 'category_rate' as MeasuredPricingSource,
      pricing_basis: `No exact cost rate match. Used ${tradeName} category average (${fallback.sampleCount} comparable rate${fallback.sampleCount === 1 ? '' : 's'}).`,
      matched: true,
    }
  })

  // Tier 4: AI measured-rate — only items that are still unmatched AND have
  // a real quantity+unit (guarantees this is a "measured but unpriceable"
  // case, never a stand-in for a genuinely unmeasured item — that's what AI
  // Allowance, a completely separate code path in Stage 6, is for).
  const aiCandidates: AiRateCandidate[] = []
  afterCategory.forEach((r, index) => {
    if (!isEligibleForAiMeasuredRate({ matched: r.matched, unit: r.item.unit, quantity: r.item.quantity })) return
    aiCandidates.push({
      index, description: r.item.description, tradeName: tradeCategoryName(r.item.trade_category_id),
      unit: r.item.unit as string, quantity: r.item.quantity,
    })
  })
  // Bounded, same reasoning as LEARNED_RATE_BATCH_SIZE below: a single
  // unbounded prompt covering every AI-measured-rate candidate at once has
  // no ceiling on request/response size, and this call sits synchronously
  // on ensureQuotePriced's caller (the quote GET route's lazy pricing
  // backfill) -- a one-time large backlog (e.g. a quote priced for the
  // first time well after Stage 6 generated it) can push a single call past
  // the platform's request timeout, observed live as an HTTP 502
  // "Application failed to respond" on a 220-line-item quote. Capping this
  // tier per pass, like every other bounded loop in this codebase, trades
  // "resolve everything in one pass" for "make bounded, guaranteed progress
  // every pass" -- ensureQuotePriced is idempotent and re-runs on every
  // subsequent quote read, so candidates past the cap are simply picked up
  // by the next call, never silently dropped.
  const boundedAiCandidates = aiCandidates.slice(0, MAX_AI_MEASURED_RATE_CANDIDATES_PER_PASS)
  const aiResults = await resolveAiMeasuredRates(supabase, builderId, boundedAiCandidates)

  const final = afterCategory.map((r, index) => {
    if (r.matched) return r
    const ai = aiResults.get(index)
    if (!ai || ai.rate === null) {
      return { ...r, pricing_source: 'unresolved' as MeasuredPricingSource }
    }
    const total = r.item.quantity !== null && r.item.quantity > 0 ? round2(r.item.quantity * ai.rate) : null
    return {
      ...r,
      rate: ai.rate, total,
      pricing_source: 'ai_measured_rate' as MeasuredPricingSource,
      pricing_basis: ai.reasoning,
      matched: true,
      _aiConfidence: ai.confidence,
    }
  })

  return final.map((r) => {
    const aiConfidence = (r as { _aiConfidence?: number | null })._aiConfidence ?? null
    const docConfidence = (r as { _docConfidence?: number | null })._docConfidence ?? null
    const tierConfidence = r.pricing_source === 'document_selection' ? (docConfidence ?? 85)
      : r.pricing_source === 'ai_measured_rate' ? aiConfidence
      : r.pricing_source === 'category_rate' ? 55
      : r.pricing_source === 'retail_baseline' ? 50
      : r.pricing_source === 'cost_rates_normalized' ? 70
      : r.pricing_source === 'cost_rates_exact' ? 90
      : null
    return {
      ...r.item,
      rate: r.rate, total: r.total,
      pricing_source: r.pricing_source, pricing_basis: r.pricing_basis,
      material_cost: (r as { material_cost?: number | null }).material_cost ?? null,
      labour_cost: (r as { labour_cost?: number | null }).labour_cost ?? null,
      confidence: withMinConfidence(r.item, tierConfidence),
    }
  })
}

/**
 * Quote-level totals from line items. Excluded items never count.
 * Confidence is the LOWEST included line item confidence — the weakest link
 * drives the score, one bad extraction cannot be hidden.
 *
 * price_coverage_pct: % of included items with a non-null total. Exists so
 * total_cost is never presented without a visible signal of how much of the
 * quote it actually reflects — a quote where most items are still
 * unresolved/unpriced should never look identical to a fully-priced one just
 * because both happen to render as a dollar figure. 100 when there are no
 * included items (nothing to fall short of covering).
 */
// Sources that reflect an actual market/measured rate, not a judgment call —
// the distinction pricing_match_rate_pct exists to draw (migration 072).
// ai_measured_rate, category_rate, ai_allowance, and manual are all
// legitimate ways to get a price, but none of them are a confirmed rate.
const RELIABLE_PRICING_SOURCES = new Set(['document_selection', 'cost_rates_exact', 'cost_rates_normalized', 'document', 'builder_rate', 'network_rate'])

export function computeQuoteTotals(
  items: Array<{
    total: number | null
    confidence: number | null
    assumption_status: string | null
    pricing_source?: string | null
  }>
): { total_cost: number; confidence_score: number; price_coverage_pct: number; pricing_match_rate_pct: number; allowance_pct: number } {
  const included = items.filter((i) => i.assumption_status !== 'excluded')
  const total_cost = round2(included.reduce((sum, i) => sum + (i.total ?? 0), 0))
  const confidences = included
    .map((i) => i.confidence)
    .filter((c): c is number => c !== null)
  const confidence_score = confidences.length > 0 ? Math.min(...confidences) : 0
  const pricedCount = included.filter((i) => i.total !== null).length
  const price_coverage_pct = included.length > 0 ? round2((pricedCount / included.length) * 100) : 100
  const reliableCount = included.filter((i) => i.pricing_source && RELIABLE_PRICING_SOURCES.has(i.pricing_source)).length
  const pricing_match_rate_pct = included.length > 0 ? round2((reliableCount / included.length) * 100) : 100
  // Dollar-weighted, not item-count-weighted — "72% of estimate VALUE",
  // not "72% of line items." A quote dominated by a few large allowances
  // (a pool, a lift, a structural engineer fee) needs this to be visible
  // even when it's a small fraction of the item count. 0 (not 100) when
  // total_cost is 0 — there's no value for allowances to have captured a
  // share of, which is a neutral/good state here, unlike coverage/match-rate
  // where "nothing to fall short of" is the good state.
  const allowanceValue = included
    .filter((i) => i.pricing_source === 'ai_allowance')
    .reduce((sum, i) => sum + (i.total ?? 0), 0)
  const allowance_pct = total_cost > 0 ? round2((allowanceValue / total_cost) * 100) : 0
  return { total_cost, confidence_score, price_coverage_pct, pricing_match_rate_pct, allowance_pct }
}

/**
 * Price a quote that extraction left unpriced. The intake edge function only
 * extracts quantities; this runs afterwards (from the intake SSE poller when
 * extraction completes, and lazily from the quote GET as a backfill) to
 * resolve rates and totals. Idempotent: a quote with a non-null total_cost is
 * left untouched, and line items that already carry a rate keep it.
 * Best-effort: never throws. Returns true when pricing was applied.
 */
export async function ensureQuotePriced(
  supabase: SupabaseClient,
  quoteId: string
): Promise<boolean> {
  const startedAt = Date.now()
  try {
    const { data: quote } = await supabase
      .from('quotes')
      .select('id, job_id, builder_id, total_cost, margin_pct')
      .eq('id', quoteId)
      .single()
    if (!quote) return false

    const { data: items } = await supabase
      .from('quote_line_items')
      .select('id, trade_category_id, description, quantity, unit, rate, total, confidence, assumption_status, pricing_source')
      .eq('quote_id', quoteId)
    if (!items || items.length === 0) return false

    const { data: builderRow } = await supabase
      .from('builders')
      .select('state')
      .eq('id', quote.builder_id)
      .single()

    // "Needs pricing" means no TOTAL exists yet — not "no rate exists yet".
    // Was `i.rate === null`, which predates any pricing mechanism that
    // legitimately sets total without rate. An AI Allowance (migration 071)
    // is exactly that: a considered lump-sum total with no meaningful unit
    // rate, by design. The old filter swept every allowance item back into
    // priceLineItems, which (having no unit, the norm for an allowance)
    // returned total: null for it — silently wiping the real allowance
    // figure out of the in-memory totals computation below (the DB row
    // itself was untouched; only total_cost/price_coverage_pct were
    // corrupted). Confirmed on a real run: 147/171 items actually had a
    // persisted total, but price_coverage_pct read back as 18% (≈31/171)
    // because 116 AI Allowance items got re-swept and nulled here.
    const unpriced = items.filter((i) => i.total === null)
    if (unpriced.length === 0) {
      // Every item already carries a total, but the quote-level cache
      // (quotes.total_cost) was never successfully written -- confirmed live
      // on a real quote (252/252 line items priced, quotes.total_cost still
      // null days later): a prior call's own quotes.update() at the bottom
      // of this function can fail (timeout, transient error) AFTER the line-
      // item batch upsert already committed, and once every item is priced,
      // `unpriced.length === 0` short-circuited every subsequent call before
      // it ever got another chance to compute/write the aggregate -- a
      // permanently stuck state despite the pricing itself being complete.
      // "Idempotent, resumes work" (this function's own doc comment) should
      // cover this case too: recompute and write the totals from the
      // already-priced items, skip only when there is truly nothing left to
      // do (no new items to price AND totals already cached).
      if (quote.total_cost !== null) return false
      const { total_cost, confidence_score, price_coverage_pct, pricing_match_rate_pct, allowance_pct } = computeQuoteTotals(items)
      const { error: totalsUpdateErr } = await supabase
        .from('quotes')
        .update({
          total_cost, confidence_score, price_coverage_pct, pricing_match_rate_pct, allowance_pct,
          margin_pct: quote.margin_pct ?? DEFAULT_MARGIN_PCT,
        })
        .eq('id', quoteId)
      if (totalsUpdateErr) {
        console.error('ensureQuotePriced: totals-only update failed:', totalsUpdateErr.message)
        return false
      }
      console.log(JSON.stringify({ event: 'ensure_quote_priced_totals_only', quote_id: quoteId, item_count: items.length, duration_ms: Date.now() - startedAt }))
      return true
    }

    // Document-confirmed selections (Tier 0) — a builder's own already-
    // extracted, confirmed product/schedule price always outranks a generic
    // catalogue/AI rate for the same physical item. Best-effort: a failed
    // fetch here must never block normal pricing, so it silently falls back
    // to an empty list (identical to today's behaviour) rather than throwing.
    let documentSelections: DocumentSelectionFact[] = []
    try {
      const { data: factRows } = await supabase
        .from('project_facts')
        .select('id, category, key, value, confidence, source_document_id, created_at')
        .eq('job_id', quote.job_id)
        .eq('superseded', false)
        .in('category', ['fixtures', 'materials'])
      documentSelections = (factRows ?? []).map((f: { id: string; category: string; key: string; value: string; confidence: number | null; source_document_id: string | null; created_at: string | null }) => ({
        fact_id: f.id, category: f.category, key: f.key, value: f.value,
        confidence: f.confidence, source_document_id: f.source_document_id, created_at: f.created_at,
      }))
    } catch (err) {
      console.error('ensureQuotePriced: failed to fetch document selections (continuing without them)', err)
    }

    const priced = await priceLineItems(
      supabase,
      quote.builder_id,
      builderRow?.state ?? null,
      unpriced,
      documentSelections
    )

    // Batched upsert instead of one round trip per line item — quotes with
    // 20-40 unpriced lines previously issued that many sequential updates.
    // Supabase's upsert is INSERT ... ON CONFLICT DO UPDATE under the hood —
    // Postgres requires every NOT NULL column to be satisfied in the INSERT
    // branch even though every one of these rows already exists and will
    // hit the conflict path. Carrying quote_id/trade_category_id/description
    // through (unchanged values, since these rows are never newly created
    // here) is what makes the statement valid; omitting them (as before)
    // failed the whole batch with "null value in column quote_id violates
    // not-null constraint" — confirmed on a real ~195-line-item quote, never
    // caught at the smaller scale this was originally written against.
    const rowsToUpdate = priced
      .map((p, i) => ({
        id: unpriced[i].id, quote_id: quoteId,
        trade_category_id: unpriced[i].trade_category_id, description: unpriced[i].description,
        rate: p.rate, total: p.total,
        pricing_source: p.pricing_source, pricing_basis: p.pricing_basis, confidence: p.confidence,
        material_cost: p.material_cost ?? null, labour_cost: p.labour_cost ?? null,
      }))
      .filter((row) => row.rate !== null)

    if (rowsToUpdate.length > 0) {
      const { error: batchUpdateErr } = await supabase.from('quote_line_items').upsert(rowsToUpdate)
      if (batchUpdateErr) console.error('ensureQuotePriced: batch update failed:', batchUpdateErr.message)
    }

    // Merge priced values back for the totals computation
    const pricedById = new Map(priced.map((p, i) => [unpriced[i].id, p]))
    const finalItems = items.map((item) => pricedById.get(item.id) ?? item)
    const { total_cost, confidence_score, price_coverage_pct, pricing_match_rate_pct, allowance_pct } = computeQuoteTotals(finalItems)

    const { error: quoteUpdateErr } = await supabase
      .from('quotes')
      .update({
        total_cost,
        confidence_score,
        price_coverage_pct,
        pricing_match_rate_pct,
        allowance_pct,
        margin_pct: quote.margin_pct ?? DEFAULT_MARGIN_PCT,
      })
      .eq('id', quoteId)
    // Previously unchecked -- a failure here (transient DB error, timeout)
    // was silently swallowed while the function still returned true, leaving
    // the caller believing pricing succeeded when the quote-level totals
    // never actually landed. Now logged so a real failure is at least
    // visible; the unpriced.length === 0 branch above is what makes this
    // recoverable on a later call instead of stuck permanently.
    if (quoteUpdateErr) console.error('ensureQuotePriced: quote totals update failed:', quoteUpdateErr.message)

    console.log(JSON.stringify({ event: 'ensure_quote_priced', quote_id: quoteId, item_count: items.length, priced_count: rowsToUpdate.length, duration_ms: Date.now() - startedAt }))

    return true
  } catch (err) {
    console.error('ensureQuotePriced failed:', err)
    return false
  }
}

/**
 * Re-derive quotes.total_cost / confidence_score from the current line items.
 * Called after any line item mutation (assumption resolved, quantity adjusted).
 * Best-effort: never throws.
 */
export async function recomputeQuoteTotals(
  supabase: SupabaseClient,
  quoteId: string
): Promise<void> {
  try {
    const { data: items } = await supabase
      .from('quote_line_items')
      .select('total, confidence, assumption_status, pricing_source')
      .eq('quote_id', quoteId)

    if (!items) return

    const { total_cost, confidence_score, price_coverage_pct, pricing_match_rate_pct, allowance_pct } = computeQuoteTotals(items)

    const { data: quote } = await supabase
      .from('quotes')
      .select('margin_pct')
      .eq('id', quoteId)
      .single()

    await supabase
      .from('quotes')
      .update({
        total_cost,
        confidence_score,
        price_coverage_pct,
        pricing_match_rate_pct,
        allowance_pct,
        margin_pct: quote?.margin_pct ?? DEFAULT_MARGIN_PCT,
      })
      .eq('id', quoteId)
  } catch (err) {
    console.error('recomputeQuoteTotals failed:', err)
  }
}

/** Bounded concurrency for captureLearnedRates below — see its own comment. */
const LEARNED_RATE_BATCH_SIZE = 25

/**
 * Tier 1 capture: when a quote is approved, fold its priced line items into
 * builder_learned_rates (running average keyed by line_item_key).
 * Best-effort: never throws — learning must not break the approval action.
 */
export async function captureLearnedRates(
  supabase: SupabaseClient,
  quoteId: string
): Promise<void> {
  try {
    const { data: quote } = await supabase
      .from('quotes')
      .select('builder_id')
      .eq('id', quoteId)
      .single()
    if (!quote) return

    const { data: items } = await supabase
      .from('quote_line_items')
      .select('trade_category_id, description, unit, rate, assumption_status, pricing_type')
      .eq('quote_id', quoteId)
    if (!items) return

    // The SAME shared catalogue priceLineItems() matched this quote's items
    // against — using a narrower cost_rates-only catalogue here (as this used
    // to) let a retail-matched item (e.g. a specific branded product) learn
    // under a different, more generic key than it was actually priced under.
    const catalogue = await loadPricingCatalogue(supabase)

    // Atomic per-item upsert (running average computed inside the DB, see
    // migration 023) — safe to run concurrently since each RPC call is a
    // single atomic statement, unlike the old select-then-branch which could
    // lose an update between two concurrent quote approvals.
    //
    // Bounded concurrency: this used to be one unbounded Promise.all firing
    // an RPC per measured line item — a quote with hundreds of lines (a
    // large commercial job) would fan out hundreds of simultaneous
    // connections to the same builder_id's learned-rate rows at once, all
    // contending on the same upsert. Chunked into fixed-size batches
    // (LEARNED_RATE_BATCH_SIZE = 25, within the reliability-refactor's
    // approved 20-50 range) run sequentially, each batch itself still
    // parallel — bounds peak concurrency without changing what gets
    // learned or losing any item's contribution.
    const eligibleItems = items.filter((item) => {
      if (item.rate === null || item.assumption_status === 'excluded') return false
      // PC allowances and provisional sums are placeholders by definition —
      // a nominal PS figure entered to unblock a quote is not a market
      // rate, and folding it into the learned average would poison Tier 1
      // pricing for every future quote. Only measured lines teach.
      const pricingType = (item as { pricing_type?: string | null }).pricing_type
      return !pricingType || pricingType === 'measured'
    })
    for (let i = 0; i < eligibleItems.length; i += LEARNED_RATE_BATCH_SIZE) {
      const batch = eligibleItems.slice(i, i + LEARNED_RATE_BATCH_SIZE)
      await Promise.all(
        batch.map(async (item) => {
          const match = matchLineItemKey({ ...item, quantity: null }, catalogue)
          if (!match || !item.unit) return

          const { error: rpcError } = await supabase.rpc('upsert_learned_rate', {
            p_builder_id: quote.builder_id,
            p_line_item_key: match.key,
            p_rate: item.rate,
            p_unit: item.unit,
          })
          if (rpcError) console.error('upsert_learned_rate failed:', rpcError.message)
        })
      )
    }
  } catch (err) {
    console.error('captureLearnedRates failed:', err)
  }
}

/**
 * Weight to apply when an actual-cost sample folds into builder_learned_rates
 * — ground truth from a completed job should move the running average faster
 * than a quoted-but-unverified sale price (see upsert_learned_rate, migration
 * 083, and the pricing-intelligence design's Tier 1 fix).
 */
const ACTUAL_COST_LEARNING_WEIGHT = 2

/** Reject an implausible per-trade variance ratio rather than poison every
 *  learned rate in that trade from what's almost certainly a data-entry
 *  error (e.g. a builder typing $5,000 when they meant $50,000). */
const MIN_PLAUSIBLE_VARIANCE_RATIO = 0.3
const MAX_PLAUSIBLE_VARIANCE_RATIO = 3.0

/**
 * Phase 1 of the pricing-intelligence design: when a builder closes out a
 * job (POST /api/estimation/reconcile), fold the ACTUAL cost per trade back
 * into Tier 1 (builder_learned_rates) — the gap the investigation confirmed:
 * captureLearnedRates only ever learns from the quoted/sold rate, never from
 * what a job actually cost.
 *
 * The close-out workflow is deliberately trade-level only (a builder will
 * not do a 30-minute per-line-item accounting exercise), so there is no
 * actual cost for any individual line item — only a per-trade total. This
 * applies the trade's overall variance ratio (actual / estimated)
 * proportionally to every already-priced measured line item in that trade,
 * which is a defensible approximation, not exact per-SKU ground truth: it
 * assumes the ESTIMATE's internal cost distribution across items in a trade
 * was roughly right even when the total wasn't, which is the same
 * assumption an experienced estimator makes when told "framing ran 12% over"
 * without a full re-measure. Best-effort: never throws.
 */
/** A builder-facing summary of what actually changed as a result of a close-
 *  out, so the UI can show something concrete ("cladding knowledge updated")
 *  instead of only a generic success message. One entry per trade whose
 *  variance was large enough to be worth mentioning (see
 *  MEANINGFUL_VARIANCE_PCT) — never emitted for a negligible difference. */
export interface ActualCostLearningSummary {
  trade_category_id: number
  trade_name: string
  unit: string
  previous_rate: number
  new_rate: number
  variance_pct: number
}

/** Below this variance, a trade's close-out isn't worth surfacing to the
 *  builder as a "knowledge update" — noise, not signal. */
const MEANINGFUL_VARIANCE_PCT = 5

export async function applyActualCostLearning(
  supabase: SupabaseClient,
  quoteId: string,
  tradeVariances: Array<{ trade_category_id: number; estimated_cost: number; actual_cost: number | null }>
): Promise<ActualCostLearningSummary[]> {
  const summary: ActualCostLearningSummary[] = []
  try {
    const { data: quote } = await supabase
      .from('quotes')
      .select('builder_id')
      .eq('id', quoteId)
      .single()
    if (!quote) return summary

    const { data: items } = await supabase
      .from('quote_line_items')
      .select('trade_category_id, description, unit, rate, assumption_status, pricing_type')
      .eq('quote_id', quoteId)
    if (!items) return summary

    // The SAME shared catalogue priceLineItems() used — see the identical
    // note on captureLearnedRates above.
    const catalogue = await loadPricingCatalogue(supabase)

    for (const variance of tradeVariances) {
      if (variance.actual_cost === null || variance.estimated_cost <= 0) continue
      const ratio = variance.actual_cost / variance.estimated_cost
      if (ratio < MIN_PLAUSIBLE_VARIANCE_RATIO || ratio > MAX_PLAUSIBLE_VARIANCE_RATIO) {
        console.error(`applyActualCostLearning: implausible variance ratio ${ratio} for trade ${variance.trade_category_id}, skipping`)
        continue
      }

      const tradeItems = items.filter((item) => {
        if (item.trade_category_id !== variance.trade_category_id) return false
        if (item.rate === null || item.assumption_status === 'excluded') return false
        const pricingType = (item as { pricing_type?: string | null }).pricing_type
        return !pricingType || pricingType === 'measured'
      })

      let representative: { unit: string; previousRate: number } | null = null

      await Promise.all(
        tradeItems.map(async (item) => {
          const match = matchLineItemKey({ ...item, quantity: null }, catalogue)
          if (!match || !item.unit) return
          if (!representative) representative = { unit: item.unit, previousRate: item.rate as number }

          const { error: rpcError } = await supabase.rpc('upsert_learned_rate', {
            p_builder_id: quote.builder_id,
            p_line_item_key: match.key,
            p_rate: round2(item.rate * ratio),
            p_unit: item.unit,
            p_weight: ACTUAL_COST_LEARNING_WEIGHT,
            p_learned_from: 'actual_cost',
          })
          if (rpcError) console.error('upsert_learned_rate (actual_cost) failed:', rpcError.message)
        })
      )

      const variancePct = Math.round((ratio - 1) * 1000) / 10
      if (representative && Math.abs(variancePct) >= MEANINGFUL_VARIANCE_PCT) {
        const rep: { unit: string; previousRate: number } = representative
        summary.push({
          trade_category_id: variance.trade_category_id,
          trade_name: tradeCategoryName(variance.trade_category_id),
          unit: rep.unit,
          previous_rate: rep.previousRate,
          new_rate: round2(rep.previousRate * ratio),
          variance_pct: variancePct,
        })
      }
    }
  } catch (err) {
    console.error('applyActualCostLearning failed:', err)
  }
  return summary
}
