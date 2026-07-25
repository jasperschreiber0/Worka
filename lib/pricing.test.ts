import { test } from 'node:test'
import assert from 'node:assert/strict'
// Relative .ts import — same reason project-context.test.ts / readiness.test.ts
// document: must resolve identically under plain `node --experimental-strip-types`
// and under Next.js/webpack.
import {
  applyMargin,
  computeQuoteTotals,
  normalizeUnit,
  DEFAULT_MARGIN_PCT,
  PRICE_BASIS_LABEL,
  CLIENT_PRICE_DISCLAIMER,
  matchLineItemKey,
  resolveCategoryFallbackRate,
  isEligibleForAiMeasuredRate,
  tokenize,
  type CatalogueEntry,
  type RateContext,
} from './pricing.ts'

// ─── applyMargin — the only function that ever produces a client-facing price ─

test('applyMargin: cost marked up by a whole-number percentage', () => {
  assert.equal(applyMargin(1000, 18), 1180)
  assert.equal(applyMargin(50000, 20), 60000)
})

test('applyMargin: 0% margin returns cost unchanged', () => {
  assert.equal(applyMargin(1000, 0), 1000)
})

test('applyMargin: rounds to 2 decimal places', () => {
  assert.equal(applyMargin(333.33, 15), 383.33) // 383.3295 -> 383.33
})

// ─── GST-exclusivity — the product decision this remediation pass locks in ──
// See lib/pricing.ts's own comment above PRICE_BASIS_LABEL: WorkA's
// client-facing price is deliberately cost * (1 + margin_pct) ONLY. This
// test is a regression guard, not a formality — it fails loudly if a future
// change starts silently folding quotes.gst_pct (or contingency_pct) into
// applyMargin's output, which would change the number on every quote a
// client has already been sent without anyone deciding that on purpose.

test('applyMargin: output is margin-only — proves GST is NOT silently applied', () => {
  const cost = 100000
  const marginPct = 18
  const marginOnly = applyMargin(cost, marginPct)
  assert.equal(marginOnly, 118000)

  // What Option A (GST-inclusive, rejected — see lib/pricing.ts) would have
  // produced at the standard 10% GST rate, for contrast: 118000 * 1.10 =
  // 129800. applyMargin's real output must NOT match this.
  const hypotheticalGstInclusive = marginOnly * 1.10
  assert.notEqual(marginOnly, hypotheticalGstInclusive)
})

test('PRICE_BASIS_LABEL and CLIENT_PRICE_DISCLAIMER are defined and state the price is GST-exclusive', () => {
  assert.match(PRICE_BASIS_LABEL, /gst/i)
  assert.match(PRICE_BASIS_LABEL, /excl/i)
  assert.match(CLIENT_PRICE_DISCLAIMER, /exclude/i)
  assert.match(CLIENT_PRICE_DISCLAIMER, /gst/i)
})

// ─── computeQuoteTotals — the arithmetic behind quotes.total_cost ──────────

test('computeQuoteTotals: sums only included items', () => {
  const { total_cost } = computeQuoteTotals([
    { total: 1000, confidence: 90, assumption_status: null },
    { total: 2000, confidence: 80, assumption_status: null },
    { total: 5000, confidence: 100, assumption_status: 'excluded' },
  ])
  assert.equal(total_cost, 3000)
})

test('computeQuoteTotals: a null total (unpriced) contributes $0 to the sum — this is exactly why isSilentlyUnpriced/readiness must catch it separately', () => {
  const { total_cost } = computeQuoteTotals([
    { total: 1000, confidence: 90, assumption_status: null },
    { total: null, confidence: 70, assumption_status: null },
  ])
  assert.equal(total_cost, 1000)
})

test('computeQuoteTotals: confidence_score is the LOWEST included confidence, not an average', () => {
  const { confidence_score } = computeQuoteTotals([
    { total: 1000, confidence: 95, assumption_status: null },
    { total: 2000, confidence: 40, assumption_status: null },
    { total: 999, confidence: 10, assumption_status: 'excluded' }, // excluded — must not drag the score down
  ])
  assert.equal(confidence_score, 40)
})

test('computeQuoteTotals: no included items with a confidence value scores 0, not null/NaN', () => {
  const { confidence_score } = computeQuoteTotals([
    { total: 500, confidence: null, assumption_status: null },
  ])
  assert.equal(confidence_score, 0)
})

// ─── price_coverage_pct — migration 071. The signal that stops a partially
// -priced quote's total_cost from looking identical to a fully-priced one ──

test('price_coverage_pct: 100 when every included item has a price', () => {
  const { price_coverage_pct } = computeQuoteTotals([
    { total: 1000, confidence: 90, assumption_status: null },
    { total: 2000, confidence: 80, assumption_status: null },
  ])
  assert.equal(price_coverage_pct, 100)
})

test('price_coverage_pct: reflects the real fraction priced, e.g. the 43/202 (21%) production incident', () => {
  const items = [
    ...Array(43).fill({ total: 500, confidence: 80, assumption_status: null }),
    ...Array(159).fill({ total: null, confidence: 80, assumption_status: null }),
  ]
  const { price_coverage_pct } = computeQuoteTotals(items)
  assert.equal(price_coverage_pct, 21.29) // 43/202 * 100, rounded
})

test('price_coverage_pct: excluded items are removed from BOTH the numerator and denominator', () => {
  const { price_coverage_pct } = computeQuoteTotals([
    { total: 1000, confidence: 90, assumption_status: null },
    { total: null, confidence: 80, assumption_status: 'excluded' }, // excluded + unpriced — must not count against coverage
  ])
  assert.equal(price_coverage_pct, 100)
})

test('price_coverage_pct: 100 (not 0 or NaN) when there are no included items at all — nothing to fall short of covering', () => {
  const { price_coverage_pct } = computeQuoteTotals([])
  assert.equal(price_coverage_pct, 100)
})

test('price_coverage_pct: an all-unpriced quote scores 0, not null', () => {
  const { price_coverage_pct } = computeQuoteTotals([
    { total: null, confidence: 50, assumption_status: null },
    { total: null, confidence: 50, assumption_status: null },
  ])
  assert.equal(price_coverage_pct, 0)
})

// ─── normalizeUnit — a wrong-unit rate match is a silent mispricing risk ────

test('normalizeUnit: common Australian trade unit spellings collapse to one canonical form', () => {
  assert.equal(normalizeUnit('sqm'), 'm2')
  assert.equal(normalizeUnit('m²'), 'm2')
  assert.equal(normalizeUnit('lin m'), 'lm')
  assert.equal(normalizeUnit('ea'), 'each')
  assert.equal(normalizeUnit('lump sum'), 'lot')
})

test('normalizeUnit: null passes through as null (no unit is a Gate 1 condition, not a normalization job)', () => {
  assert.equal(normalizeUnit(null), null)
})

// ─── DEFAULT_MARGIN_PCT sanity — a silently-changed default would move every future quote ──

test('DEFAULT_MARGIN_PCT is a sane, non-zero percentage', () => {
  assert.ok(DEFAULT_MARGIN_PCT > 0 && DEFAULT_MARGIN_PCT < 100)
})

// ─── matchLineItemKey — the measured-item fallback chain (migration 072) ────
// Confirmed on a real quote: 19/24 unpriced items had a clean, verified
// quantity + unit but no catalogue match — mostly branded/specific product
// descriptions. These tests build fake CatalogueEntry fixtures via the real
// tokenize() rather than hand-writing token sets, so the tests exercise the
// same normalization (synonyms, singularisation) the real matcher uses.

function entry(description: string, tradeCategoryId: number, unit: string): CatalogueEntry {
  return { line_item_key: description.toLowerCase().replace(/\s+/g, '_'), trade_category_id: tradeCategoryId, description, unit, tokens: tokenize(description) }
}

test('matchLineItemKey: full token containment classifies as exact', () => {
  const catalogue = [entry('floor waste', 11, 'each')]
  // Brodware Winslow floor waste — the exact branded example from the task —
  // contains BOTH of the catalogue entry's tokens (floor, waste) plus extra
  // brand detail, which is exactly the "exact" case: everything the
  // catalogue entry means is present in the item description.
  const match = matchLineItemKey({ trade_category_id: 11, description: 'Brodware Winslow Polished Nickel floor waste', quantity: 10, unit: 'each' }, catalogue)
  assert.ok(match)
  assert.equal(match?.strength, 'exact')
})

test('matchLineItemKey: partial token overlap classifies as normalized', () => {
  const catalogue = [entry('skylight roof flashing', 3, 'each')]
  // VELUX Solar Powered Skylight — the other branded example from the task —
  // only shares ONE of the catalogue entry's three tokens (skylight), not
  // roof/flashing. Real signal, but a plausible match, not a confirmed one.
  const match = matchLineItemKey({ trade_category_id: 3, description: 'VELUX Solar Powered Skylight', quantity: 2, unit: 'each' }, catalogue)
  assert.ok(match)
  assert.equal(match?.strength, 'normalized')
})

test('matchLineItemKey: token synonyms feed into the same exact/normalized classification (colourbond -> colorbond)', () => {
  const catalogue = [entry('colorbond roofing', 3, 'm2')]
  const match = matchLineItemKey({ trade_category_id: 3, description: 'Colourbond roofing installation', quantity: 40, unit: 'm2' }, catalogue)
  assert.ok(match)
  // 'roofing' token literally present in both -> full containment
  assert.equal(match?.strength, 'exact')
})

test('matchLineItemKey: no match across a different trade category, even with identical wording', () => {
  const catalogue = [entry('floor waste', 11, 'each')]
  const match = matchLineItemKey({ trade_category_id: 3, description: 'floor waste', quantity: 1, unit: 'each' }, catalogue)
  assert.equal(match, null)
})

test('matchLineItemKey: no match when units are incompatible', () => {
  const catalogue = [entry('floor waste', 11, 'lm')]
  const match = matchLineItemKey({ trade_category_id: 11, description: 'floor waste', quantity: 1, unit: 'each' }, catalogue)
  assert.equal(match, null)
})

test('matchLineItemKey: no match on zero token overlap — normalization does not aggressively strip meaning', () => {
  const catalogue = [entry('floor waste', 11, 'each')]
  const match = matchLineItemKey({ trade_category_id: 11, description: 'Kitchen island stone benchtop', quantity: 1, unit: 'each' }, catalogue)
  assert.equal(match, null)
})

// ─── resolveCategoryFallbackRate — tier 3, same-trade/unit average ──────────

function fakeRateContext(platform: RateContext['platform']): RateContext {
  return { learned: [], preferences: [], supplier: [], platform, network: [], catalogue: [], builderState: null }
}

test('resolveCategoryFallbackRate: averages national rates within the same trade + unit', () => {
  const ctx = fakeRateContext([
    { line_item_key: 'a', trade_category_id: 11, unit: 'each', rate: 100, state: null },
    { line_item_key: 'b', trade_category_id: 11, unit: 'each', rate: 150, state: null },
    { line_item_key: 'c', trade_category_id: 11, unit: 'each', rate: 200, state: null },
  ])
  const result = resolveCategoryFallbackRate(11, 'each', ctx)
  assert.equal(result?.rate, 150)
  assert.equal(result?.sampleCount, 3)
})

test('resolveCategoryFallbackRate: excludes other trades and incompatible units', () => {
  const ctx = fakeRateContext([
    { line_item_key: 'a', trade_category_id: 11, unit: 'each', rate: 100, state: null },
    { line_item_key: 'b', trade_category_id: 3, unit: 'each', rate: 999, state: null }, // wrong trade
    { line_item_key: 'c', trade_category_id: 11, unit: 'm2', rate: 999, state: null }, // wrong unit
  ])
  const result = resolveCategoryFallbackRate(11, 'each', ctx)
  assert.equal(result?.rate, 100)
  assert.equal(result?.sampleCount, 1)
})

test('resolveCategoryFallbackRate: state-specific rows are excluded — this is a NATIONAL average only', () => {
  const ctx = fakeRateContext([
    { line_item_key: 'a', trade_category_id: 11, unit: 'each', rate: 100, state: null },
    { line_item_key: 'b', trade_category_id: 11, unit: 'each', rate: 500, state: 'NSW' },
  ])
  const result = resolveCategoryFallbackRate(11, 'each', ctx)
  assert.equal(result?.rate, 100)
  assert.equal(result?.sampleCount, 1)
})

test('resolveCategoryFallbackRate: no candidates at all returns null (falls through to the AI tier)', () => {
  const ctx = fakeRateContext([{ line_item_key: 'a', trade_category_id: 3, unit: 'each', rate: 100, state: null }])
  assert.equal(resolveCategoryFallbackRate(11, 'each', ctx), null)
})

test('resolveCategoryFallbackRate: null unit returns null — an unmeasured item never reaches this tier via this path', () => {
  const ctx = fakeRateContext([{ line_item_key: 'a', trade_category_id: 11, unit: 'each', rate: 100, state: null }])
  assert.equal(resolveCategoryFallbackRate(11, null, ctx), null)
})

// ─── isEligibleForAiMeasuredRate — tier 4 gating, kept independently testable
// from the (unmockable, real-Claude) call itself ────────────────────────────

test('isEligibleForAiMeasuredRate: eligible when unmatched with a real quantity and unit', () => {
  assert.equal(isEligibleForAiMeasuredRate({ matched: false, unit: 'each', quantity: 5 }), true)
})

test('isEligibleForAiMeasuredRate: NOT eligible once already matched by an earlier tier', () => {
  assert.equal(isEligibleForAiMeasuredRate({ matched: true, unit: 'each', quantity: 5 }), false)
})

test('isEligibleForAiMeasuredRate: NOT eligible with no unit — this is the AI Allowance case, a different code path entirely', () => {
  assert.equal(isEligibleForAiMeasuredRate({ matched: false, unit: null, quantity: 5 }), false)
})

test('isEligibleForAiMeasuredRate: NOT eligible with a null quantity — never invents a quantity to price against', () => {
  assert.equal(isEligibleForAiMeasuredRate({ matched: false, unit: 'each', quantity: null }), false)
})

test('isEligibleForAiMeasuredRate: NOT eligible with a zero or negative quantity', () => {
  assert.equal(isEligibleForAiMeasuredRate({ matched: false, unit: 'each', quantity: 0 }), false)
  assert.equal(isEligibleForAiMeasuredRate({ matched: false, unit: 'each', quantity: -3 }), false)
})

// ─── computeQuoteTotals: pricing_match_rate_pct — distinct from price_coverage_pct ──

test('pricing_match_rate_pct: 100 when every included item came from a reliable source', () => {
  const { pricing_match_rate_pct } = computeQuoteTotals([
    { total: 100, confidence: 90, assumption_status: null, pricing_source: 'cost_rates_exact' },
    { total: 200, confidence: 90, assumption_status: null, pricing_source: 'document' },
  ])
  assert.equal(pricing_match_rate_pct, 100)
})

test('pricing_match_rate_pct: a fully-priced quote can still have a LOW match rate — the exact case this metric exists to catch', () => {
  const { price_coverage_pct, pricing_match_rate_pct } = computeQuoteTotals([
    { total: 100, confidence: 60, assumption_status: null, pricing_source: 'ai_allowance' },
    { total: 200, confidence: 55, assumption_status: null, pricing_source: 'category_rate' },
    { total: 300, confidence: 50, assumption_status: null, pricing_source: 'ai_measured_rate' },
  ])
  assert.equal(price_coverage_pct, 100) // every item has a total
  assert.equal(pricing_match_rate_pct, 0) // none of them are a confirmed rate match
})

test('pricing_match_rate_pct: excluded items are removed from both numerator and denominator', () => {
  const { pricing_match_rate_pct } = computeQuoteTotals([
    { total: 100, confidence: 90, assumption_status: null, pricing_source: 'cost_rates_exact' },
    { total: null, confidence: 50, assumption_status: 'excluded', pricing_source: 'ai_measured_rate' },
  ])
  assert.equal(pricing_match_rate_pct, 100)
})

test('pricing_match_rate_pct: 100 (not 0/NaN) when there are no included items', () => {
  assert.equal(computeQuoteTotals([]).pricing_match_rate_pct, 100)
})

test('pricing_match_rate_pct: an item with no pricing_source at all (not yet priced) counts as unreliable, not reliable', () => {
  const { pricing_match_rate_pct } = computeQuoteTotals([
    { total: 100, confidence: 90, assumption_status: null, pricing_source: 'cost_rates_exact' },
    { total: null, confidence: null, assumption_status: null, pricing_source: null },
  ])
  assert.equal(pricing_match_rate_pct, 50)
})
