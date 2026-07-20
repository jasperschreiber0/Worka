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
