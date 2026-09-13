import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_PROFILE,
  financialProfile,
  marginGate,
  profitabilityReview,
  comparableLearning,
  cashForecast,
  riskSummary,
  waterfallLayout,
} from './profitability.ts'
test('20% markup is 16.67% margin; recommended price uses margin denominator', () => {
  const g = marginGate(500000, 600000, 12, 22)
  assert.equal(g.markup, 20)
  assert.ok(Math.abs(g.margin! - 16.666666) < 0.001)
  assert.equal(g.recommendedPrice, 641025.64)
  assert.equal(g.status, 'TIGHT')
  assert.equal(marginGate(500000, 590000, 12, 22).shortfall, 51025.64)
  assert.equal(marginGate(500000, g.recommendedPrice, 12, 22).status, 'HEALTHY')
})
test('waterfall includes negative balances without clipping and estimated hours stay explicit', () => {
  const bars = waterfallLayout([
    { label: 'Start', amount: 100 },
    { label: 'Overrun', amount: -200 },
    { label: 'End', amount: -100 },
  ])
  assert.equal(bars[1].width, 100)
  assert.equal(bars[1].left, 0)
  assert.equal(bars[2].left, 0)
  const r = profitabilityReview(
    [{ id: 'e', trade_category_id: 2, description: 'Framing', total: 18000, margin_pct: 0.2 }],
    [{ id: 'a', trade_category_id: 2, description: 'Labour', amount: 24000, labour_hours: 240 }],
    30000,
    0,
    true,
    { '2': 180 },
  )
  assert.equal(r.trades[0].hoursVariance, 60)
  assert.equal(r.trades[0].estimatedHours, 180)
})
test('overhead target, zero revenue and impossible target remain explicit', () => {
  assert.equal(financialProfile(EMPTY_PROFILE).minimumMargin, null)
  const p = financialProfile({
    ...EMPTY_PROFILE,
    targetRevenue: 2000000,
    annualOverhead: 240000,
    netProfitPct: 10,
  })
  assert.equal(p.targetMargin, 22)
  assert.equal(p.monthlyOverhead, 20000)
  assert.equal(p.targetProfit, 200000)
  assert.equal(
    financialProfile({ ...EMPTY_PROFILE, targetRevenue: 100, annualOverhead: 120 }).viable,
    false,
  )
  assert.throws(() => marginGate(1, 1, 100, 100))
  assert.throws(() => marginGate(NaN, 2, 1, 2))
})
test('review excludes variation representation and commitments; waterfall reconciles once', () => {
  const r = profitabilityReview(
    [
      { id: 'e', trade_category_id: 2, description: 'Frame', total: 100, margin_pct: 0.2 },
      {
        id: 'v',
        trade_category_id: 2,
        description: 'Change',
        total: 50,
        margin_pct: 0,
        variation_id: 'v',
      },
    ],
    [
      { id: 'a', trade_category_id: 2, description: 'Frame invoice', amount: 140 },
      { id: 'b', trade_category_id: null, description: 'Permit', amount: 10 },
      {
        id: 'c',
        trade_category_id: 2,
        description: 'Committed',
        amount: 200,
        cost_kind: 'committed',
      },
    ],
    150,
    50,
    true,
  )
  assert.equal(r.estimatedCost, 100)
  assert.equal(r.actualCost, 150)
  assert.equal(r.actualProfit, 50)
  assert.equal(
    r.waterfall.slice(0, -1).reduce((s, r) => s + r.amount, 0),
    r.actualProfit,
  )
  assert.equal(r.trades[0].variance, 40)
})
test('unknown estimate costs cannot become completed learning', () => {
  assert.equal(
    profitabilityReview(
      [{ id: 'e', trade_category_id: 2, description: 'Unknown', total: null, margin_pct: 0 }],
      [],
      100,
      0,
      true,
    ).complete,
    false,
  )
})
test('segmented learning uses weighted costs and deduplicates jobs', () => {
  const c = {
    jobId: 'next',
    jobType: 'renovation',
    region: 'Sydney',
    complexity: 'high',
    constructionType: 'timber',
    size: 200,
  }
  const a = { ...c, jobId: 'a', trade: 2, estimated: 100, actual: 120, complete: true },
    b = { ...a, jobId: 'b', estimated: 300, actual: 330 }
  const r = comparableLearning(
    [
      a,
      b,
      { ...a, jobId: 'wrong', jobType: 'new build' },
      { ...a, jobId: 'unfinished', complete: false },
    ],
    c,
  )
  assert.equal(r[0].adjustmentPct, 12.5)
  assert.equal(r[0].count, 2)
  assert.equal(r[0].confidence, 'Low')
  assert.equal(comparableLearning([a], { ...c, region: '' }).length, 0)
})
test('cash balances and deficits use bank movement arithmetic', () => {
  const f = cashForecast(
    100,
    Array.from({ length: 13 }, () => ({ inflow: 10, outflow: 20 })),
  )
  assert.equal(f.lowest, -30)
  assert.equal(f.lowestWeek, 13)
  assert.equal(f.deficitWeeks, 3)
})
test('risks distinguish unknown and recovered amounts from definite losses', () => {
  const r = riskSummary([
    {
      id: 'r',
      title: 'Change',
      trade_category_id: 2,
      estimated_cost: null,
      proposed_charge: null,
      status: 'potential',
      recovered: 0,
      incurred: 0,
      billed: 0,
      evidence: 'Email',
    },
  ])
  assert.equal(r.atRisk, 0)
  assert.equal(r.unknown, 1)
  assert.equal(r.recoveryRate, null)
})
