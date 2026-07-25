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

function tokenize(text: string): Set<string> {
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

interface CatalogueEntry {
  line_item_key: string
  trade_category_id: number
  description: string
  unit: string
  tokens: Set<string>
}

/**
 * Match a line item description to a catalogue line_item_key.
 * Requires same trade category and a compatible unit; scores by token overlap.
 */
function matchLineItemKey(
  item: PriceableItem,
  catalogue: CatalogueEntry[]
): string | null {
  const itemTokens = tokenize(item.description)
  const itemUnit = normalizeUnit(item.unit)
  if (itemTokens.size === 0) return null

  let bestKey: string | null = null
  let bestScore = 0

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
    }
  }

  return bestScore >= 1 ? bestKey : null
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
}

interface NetworkRateRow {
  line_item_key: string
  state: string | null
  rate_p50: number | null
}

interface RateContext {
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

  const platform = (platformRes.data ?? []) as Array<StateRateRow & { trade_category_id: number; description: string }>

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

function resolveRateForKey(
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

/**
 * Price a batch of extracted line items. Returns each item with rate and total
 * filled in where a rate could be resolved (null otherwise — never throws).
 */
export async function priceLineItems<T extends PriceableItem>(
  supabase: SupabaseClient,
  builderId: string,
  builderState: string | null,
  items: T[]
): Promise<Array<T & { rate: number | null; total: number | null }>> {
  let ctx: RateContext
  try {
    ctx = await loadRateContext(supabase, builderId, builderState)
  } catch (err) {
    console.error('priceLineItems: failed to load rate context', err)
    return items.map((item) => ({ ...item, rate: null, total: null }))
  }

  return items.map((item) => {
    // No unit means the quantity cannot be safely priced — the builder must
    // resolve the assumption first (never invent quantities)
    if (!item.unit) {
      return { ...item, rate: null, total: null }
    }

    const key = matchLineItemKey(item, ctx.catalogue)
    const resolved = key ? resolveRateForKey(key, normalizeUnit(item.unit), ctx) : null

    const rate = resolved?.rate ?? null
    const total =
      rate !== null && item.quantity !== null && item.quantity > 0
        ? round2(item.quantity * rate)
        : null

    return { ...item, rate, total }
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
export function computeQuoteTotals(
  items: Array<{
    total: number | null
    confidence: number | null
    assumption_status: string | null
  }>
): { total_cost: number; confidence_score: number; price_coverage_pct: number } {
  const included = items.filter((i) => i.assumption_status !== 'excluded')
  const total_cost = round2(included.reduce((sum, i) => sum + (i.total ?? 0), 0))
  const confidences = included
    .map((i) => i.confidence)
    .filter((c): c is number => c !== null)
  const confidence_score = confidences.length > 0 ? Math.min(...confidences) : 0
  const pricedCount = included.filter((i) => i.total !== null).length
  const price_coverage_pct = included.length > 0 ? round2((pricedCount / included.length) * 100) : 100
  return { total_cost, confidence_score, price_coverage_pct }
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
    if (!quote || quote.total_cost !== null) return false

    const { data: items } = await supabase
      .from('quote_line_items')
      .select('id, trade_category_id, description, quantity, unit, rate, total, confidence, assumption_status')
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
      }))
      .filter((row) => row.rate !== null)

    if (rowsToUpdate.length > 0) {
      const { error: batchUpdateErr } = await supabase.from('quote_line_items').upsert(rowsToUpdate)
      if (batchUpdateErr) console.error('ensureQuotePriced: batch update failed:', batchUpdateErr.message)
    }

    // Merge priced values back for the totals computation
    const pricedById = new Map(priced.map((p, i) => [unpriced[i].id, p]))
    const finalItems = items.map((item) => pricedById.get(item.id) ?? item)
    const { total_cost, confidence_score, price_coverage_pct } = computeQuoteTotals(finalItems)

    await supabase
      .from('quotes')
      .update({
        total_cost,
        confidence_score,
        price_coverage_pct,
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
      .select('total, confidence, assumption_status')
      .eq('quote_id', quoteId)

    if (!items) return

    const { total_cost, confidence_score, price_coverage_pct } = computeQuoteTotals(items)

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
        const key = matchLineItemKey({ ...item, quantity: null }, catalogue)
        if (!key || !item.unit) return

        const { error: rpcError } = await supabase.rpc('upsert_learned_rate', {
          p_builder_id: quote.builder_id,
          p_line_item_key: key,
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
