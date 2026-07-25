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

export type RateSource = 'learned' | 'preference' | 'supplier' | 'platform' | 'network'

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
}

interface StateRateRow extends RateRow {
  state: string | null
  trade_category_id: number
}

interface NetworkRateRow {
  line_item_key: string
  state: string | null
  rate_p50: number | null
}

export interface RateContext {
  learned: RateRow[]
  preferences: RateRow[]
  supplier: RateRow[]
  platform: StateRateRow[]
  network: NetworkRateRow[]
  catalogue: CatalogueEntry[]
  builderState: string | null
}

async function loadRateContext(
  supabase: SupabaseClient,
  builderId: string,
  builderState: string | null
): Promise<RateContext> {
  const stateFilter = builderState ? `state.is.null,state.eq.${builderState}` : 'state.is.null'

  const [learnedRes, prefRes, supplierRes, platformRes, networkRes] = await Promise.all([
    supabase.from('builder_learned_rates').select('line_item_key, rate, unit, sample_count').eq('builder_id', builderId),
    supabase.from('builder_rate_preferences').select('line_item_key, rate, unit').eq('builder_id', builderId),
    supabase.from('builder_supplier_rates').select('line_item_key, rate, unit').eq('builder_id', builderId),
    supabase.from('cost_rates').select('line_item_key, trade_category_id, description, unit, rate, state').or(stateFilter),
    supabase.from('network_rate_aggregates').select('line_item_key, state, rate_p50').or(stateFilter),
  ])

  const platform = (platformRes.data ?? []) as Array<StateRateRow & { description: string }>

  // The matching catalogue is built from national default rows (state IS NULL)
  const catalogue: CatalogueEntry[] = platform
    .filter((row) => row.state === null)
    .map((row) => ({
      line_item_key: row.line_item_key,
      trade_category_id: row.trade_category_id,
      description: row.description,
      unit: row.unit,
      tokens: tokenize(row.description),
    }))

  return {
    learned: (learnedRes.data ?? []) as RateRow[],
    preferences: (prefRes.data ?? []) as RateRow[],
    supplier: (supplierRes.data ?? []) as RateRow[],
    platform,
    network: (networkRes.data ?? []) as NetworkRateRow[],
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
  if (learned) return { rate: learned.rate, unit: learned.unit, source: 'learned', line_item_key: key }

  // Tier 2: preference
  const pref = ctx.preferences.find((r) => r.line_item_key === key && unitMatches(r.unit))
  if (pref) return { rate: pref.rate, unit: pref.unit, source: 'preference', line_item_key: key }

  // Tier 3: supplier (cheapest compatible rate across imported lists)
  const supplierRates = ctx.supplier.filter((r) => r.line_item_key === key && unitMatches(r.unit))
  if (supplierRates.length > 0) {
    const cheapest = supplierRates.reduce((a, b) => (b.rate < a.rate ? b : a))
    return { rate: cheapest.rate, unit: cheapest.unit, source: 'supplier', line_item_key: key }
  }

  // Tier 4: platform defaults — state-specific first, national fallback
  const platformRates = ctx.platform.filter((r) => r.line_item_key === key && unitMatches(r.unit))
  const stateRate = platformRates.find((r) => r.state !== null && r.state === ctx.builderState)
  const nationalRate = platformRates.find((r) => r.state === null)
  const platformRate = stateRate ?? nationalRate
  if (platformRate) {
    return { rate: platformRate.rate, unit: platformRate.unit, source: 'platform', line_item_key: key }
  }

  // Tier 5: network P50 — state-specific first, national fallback
  const networkRates = ctx.network.filter((r) => r.line_item_key === key && r.rate_p50 !== null)
  const networkRate =
    networkRates.find((r) => r.state !== null && r.state === ctx.builderState) ??
    networkRates.find((r) => r.state === null)
  if (networkRate && networkRate.rate_p50 !== null) {
    return { rate: networkRate.rate_p50, unit: itemUnit ?? 'each', source: 'network', line_item_key: key }
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

export type MeasuredPricingSource = 'cost_rates_exact' | 'cost_rates_normalized' | 'builder_rate' | 'network_rate' | 'category_rate' | 'ai_measured_rate' | 'unresolved'

export interface PricedItemResult {
  rate: number | null
  total: number | null
  pricing_source: MeasuredPricingSource | null
  pricing_basis: string | null
  confidence: number | null
}

const RATE_SOURCE_TO_PRICING_SOURCE: Record<RateSource, MeasuredPricingSource> = {
  learned: 'builder_rate', preference: 'builder_rate', supplier: 'builder_rate',
  platform: 'cost_rates_exact', // overridden to cost_rates_normalized below when the match was partial
  network: 'network_rate',
}

/**
 * Price a batch of extracted line items via the measured-item fallback
 * chain (migration 072):
 *   exact cost_rates match -> normalized cost_rates match ->
 *   same-trade/unit category average -> AI measured-rate estimate ->
 *   unresolved
 * Returns each item with rate/total AND its pricing_source/pricing_basis/
 * confidence filled in — never throws, never invents a quantity (only ever
 * proposes a $/unit RATE for a quantity that already exists).
 */
export async function priceLineItems<T extends PriceableItem>(
  supabase: SupabaseClient,
  builderId: string,
  builderState: string | null,
  items: T[]
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

  // Tier 1-3: exact / normalized cost_rates + the existing 5-tier hierarchy
  // (learned/preference/supplier/platform/network), run synchronously first
  // since these are cheap DB lookups with no external call.
  const afterCatalogue = items.map((item) => {
    // No unit means the quantity cannot be safely priced — the builder must
    // resolve the assumption first (never invent quantities)
    if (!item.unit) {
      return { item, rate: null as number | null, total: null as number | null, pricing_source: null as MeasuredPricingSource | null, pricing_basis: null as string | null, matched: false }
    }

    const match = matchLineItemKey(item, ctx.catalogue)
    const resolved = match ? resolveRateForKey(match.key, normalizeUnit(item.unit), ctx) : null

    if (!resolved) {
      return { item, rate: null, total: null, pricing_source: null, pricing_basis: null, matched: false }
    }

    const pricingSource: MeasuredPricingSource =
      resolved.source === 'platform' && match?.strength === 'normalized'
        ? 'cost_rates_normalized'
        : RATE_SOURCE_TO_PRICING_SOURCE[resolved.source]

    const rate = resolved.rate
    const total = item.quantity !== null && item.quantity > 0 ? round2(item.quantity * rate) : null
    return { item, rate, total, pricing_source: pricingSource, pricing_basis: null, matched: true }
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
  const aiResults = await resolveAiMeasuredRates(supabase, builderId, aiCandidates)

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
    const tierConfidence = r.pricing_source === 'ai_measured_rate' ? aiConfidence
      : r.pricing_source === 'category_rate' ? 55
      : r.pricing_source === 'cost_rates_normalized' ? 70
      : r.pricing_source === 'cost_rates_exact' ? 90
      : null
    return {
      ...r.item,
      rate: r.rate, total: r.total,
      pricing_source: r.pricing_source, pricing_basis: r.pricing_basis,
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
const RELIABLE_PRICING_SOURCES = new Set(['cost_rates_exact', 'cost_rates_normalized', 'document', 'builder_rate', 'network_rate'])

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
  try {
    const { data: quote } = await supabase
      .from('quotes')
      .select('id, builder_id, total_cost, margin_pct')
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
    if (unpriced.length === 0) return false
    const priced = await priceLineItems(
      supabase,
      quote.builder_id,
      builderRow?.state ?? null,
      unpriced
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

    await supabase
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

    // Re-use the platform catalogue to key each line item
    const { data: catalogueRows } = await supabase
      .from('cost_rates')
      .select('line_item_key, trade_category_id, description, unit')
      .is('state', null)

    const catalogue: CatalogueEntry[] = (catalogueRows ?? []).map((row) => ({
      line_item_key: row.line_item_key,
      trade_category_id: row.trade_category_id,
      description: row.description,
      unit: row.unit,
      tokens: tokenize(row.description),
    }))

    // Atomic per-item upsert (running average computed inside the DB, see
    // migration 023) — safe to run concurrently since each RPC call is a
    // single atomic statement, unlike the old select-then-branch which could
    // lose an update between two concurrent quote approvals.
    await Promise.all(
      items.map(async (item) => {
        if (item.rate === null || item.assumption_status === 'excluded') return
        // PC allowances and provisional sums are placeholders by definition —
        // a nominal PS figure entered to unblock a quote is not a market
        // rate, and folding it into the learned average would poison Tier 1
        // pricing for every future quote. Only measured lines teach.
        const pricingType = (item as { pricing_type?: string | null }).pricing_type
        if (pricingType && pricingType !== 'measured') return
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
  } catch (err) {
    console.error('captureLearnedRates failed:', err)
  }
}
