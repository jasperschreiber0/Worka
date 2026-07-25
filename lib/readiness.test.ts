import { test } from 'node:test'
import assert from 'node:assert/strict'
// Relative .ts import for the same reason project-context.test.ts documents:
// must resolve identically under plain `node --experimental-strip-types` and
// under Next.js/webpack.
import {
  deriveQuoteReadiness,
  isSilentlyUnpriced,
  getSendBlockingReasons,
  LOW_CONFIDENCE_REVIEW_THRESHOLD,
} from './estimating/readiness.ts'

// ─── deriveQuoteReadiness ───────────────────────────────────────────────────

const clean = {
  unresolvedAssumptions: 0,
  unpricedItems: 0,
  topRiskCount: 0,
  reviewItemCount: 0,
  confidenceScore: 90,
  unresolvedConservativeAssumptions: 0,
  missingTradeCount: 0,
}

test('readiness: nothing outstanding is ready', () => {
  const r = deriveQuoteReadiness(clean)
  assert.equal(r.readiness, 'ready')
  assert.deepEqual(r.blockedReasons, [])
  assert.deepEqual(r.reviewReasons, [])
})

test('readiness: an unpriced item blocks — the $0-contribution case must never look sendable', () => {
  const r = deriveQuoteReadiness({ ...clean, unpricedItems: 2 })
  assert.equal(r.readiness, 'blocked')
  assert.equal(r.blockedReasons.length, 1)
  assert.match(r.blockedReasons[0], /no price/)
  assert.match(r.blockedReasons[0], /\$0/)
})

test('readiness: unresolved assumptions block', () => {
  const r = deriveQuoteReadiness({ ...clean, unresolvedAssumptions: 3 })
  assert.equal(r.readiness, 'blocked')
  assert.match(r.blockedReasons[0], /3 items need/)
})

test('readiness: blocked wins over review_required when both apply, and review reasons still surface', () => {
  const r = deriveQuoteReadiness({ ...clean, unpricedItems: 1, topRiskCount: 2 })
  assert.equal(r.readiness, 'blocked')
  assert.equal(r.reviewReasons.length, 1)
})

test('readiness: QA risks alone are review_required, not blocked — builder judgment stays in charge', () => {
  const r = deriveQuoteReadiness({ ...clean, topRiskCount: 1 })
  assert.equal(r.readiness, 'review_required')
  assert.deepEqual(r.blockedReasons, [])
})

test('readiness: low confidence alone triggers review_required at the shared threshold', () => {
  assert.equal(deriveQuoteReadiness({ ...clean, confidenceScore: LOW_CONFIDENCE_REVIEW_THRESHOLD - 1 }).readiness, 'review_required')
  assert.equal(deriveQuoteReadiness({ ...clean, confidenceScore: LOW_CONFIDENCE_REVIEW_THRESHOLD }).readiness, 'ready')
})

test('readiness: null confidence (never computed) does not trigger the low-confidence review on its own', () => {
  assert.equal(deriveQuoteReadiness({ ...clean, confidenceScore: null }).readiness, 'ready')
})

// ─── Conservative assumptions & missing trades — promoted to BLOCKED
// (Estimate Completeness & Confidence Integrity Audit, P0-1/P0-2): detection
// already existed for both; these prove the severity reclassification. ──────

test('readiness: unresolved conservative assumptions now BLOCK — an unanswered blocking question must not look sendable', () => {
  const r = deriveQuoteReadiness({ ...clean, unresolvedConservativeAssumptions: 2 })
  assert.equal(r.readiness, 'blocked')
  assert.equal(r.blockedReasons.length, 1)
  assert.match(r.blockedReasons[0], /assumed 2/)
  assert.match(r.blockedReasons[0], /blocking question/)
})

test('readiness: a missing scoped trade now BLOCKS — a whole absent trade is invisible to unpricedItems, so it needs its own signal', () => {
  const r = deriveQuoteReadiness({ ...clean, missingTradeCount: 1 })
  assert.equal(r.readiness, 'blocked')
  assert.equal(r.blockedReasons.length, 1)
  assert.match(r.blockedReasons[0], /1 scoped trade/)
})

test('readiness: unresolved assumptions, unpriced items, missing trades, and conservative assumptions all stack independently in blockedReasons', () => {
  const r = deriveQuoteReadiness({
    ...clean,
    unresolvedAssumptions: 1,
    unpricedItems: 1,
    missingTradeCount: 1,
    unresolvedConservativeAssumptions: 1,
  })
  assert.equal(r.readiness, 'blocked')
  assert.equal(r.blockedReasons.length, 4)
})

test('readiness: zero conservative assumptions / missing trades adds nothing to either reason list', () => {
  const r = deriveQuoteReadiness(clean)
  assert.equal(r.reviewReasons.length, 0)
  assert.equal(r.blockedReasons.length, 0)
})

// ─── isSilentlyUnpriced ─────────────────────────────────────────────────────

test('isSilentlyUnpriced: a normal priced item is not', () => {
  assert.equal(isSilentlyUnpriced({ total: 1200, assumption_status: null }), false)
})

test('isSilentlyUnpriced: null total on an included non-assumption item IS silently unpriced — the core gap', () => {
  assert.equal(isSilentlyUnpriced({ total: null, assumption_status: null }), true)
})

test('isSilentlyUnpriced: excluded items never count', () => {
  assert.equal(isSilentlyUnpriced({ total: null, assumption_status: 'excluded' }), false)
})

test('isSilentlyUnpriced: an unresolved assumption is already surfaced elsewhere — not double-counted', () => {
  assert.equal(isSilentlyUnpriced({ total: null, assumption_status: 'unresolved', is_assumption: true }), false)
})

test('isSilentlyUnpriced: a resolved assumption that still has no total IS silently unpriced again', () => {
  // e.g. builder accepted a Gate-2 quantity but no pricing tier ever matched —
  // the assumption flow is done with it, yet it still contributes $0.
  assert.equal(isSilentlyUnpriced({ total: null, assumption_status: 'accepted', is_assumption: true }), true)
})

// ─── getSendBlockingReasons — the actual send-time enforcement (not just
// display state) shared by send/route.ts and confirm-send/route.ts ─────────

const noBlockers = { lineItems: [], missingTrades: [], unresolvedConservativeAssumptionCount: 0 }

test('getSendBlockingReasons: a fully clean quote returns no blocking reasons', () => {
  assert.deepEqual(getSendBlockingReasons(noBlockers), [])
})

test('getSendBlockingReasons: a silently-unpriced line item blocks sending', () => {
  const reasons = getSendBlockingReasons({
    ...noBlockers,
    lineItems: [{ description: 'Excavation', total: null, assumption_status: null }],
  })
  assert.equal(reasons.length, 1)
  assert.match(reasons[0], /no price/)
  assert.match(reasons[0], /\$0/)
})

test('getSendBlockingReasons: a missing scoped trade blocks sending, naming the trade', () => {
  const reasons = getSendBlockingReasons({
    ...noBlockers,
    missingTrades: [{ trade_name: 'Electrical' }],
  })
  assert.equal(reasons.length, 1)
  assert.match(reasons[0], /Electrical/)
  assert.match(reasons[0], /no line items/)
})

test('getSendBlockingReasons: an unresolved conservative assumption blocks sending', () => {
  const reasons = getSendBlockingReasons({
    ...noBlockers,
    unresolvedConservativeAssumptionCount: 1,
  })
  assert.equal(reasons.length, 1)
  assert.match(reasons[0], /blocking question/)
})

test('getSendBlockingReasons: all three reasons can stack independently, one per condition', () => {
  const reasons = getSendBlockingReasons({
    lineItems: [{ description: 'Excavation', total: null, assumption_status: null }],
    missingTrades: [{ trade_name: 'Electrical' }, { trade_name: 'Plumbing' }],
    unresolvedConservativeAssumptionCount: 2,
  })
  assert.equal(reasons.length, 3)
})

test('getSendBlockingReasons: excluded and already-surfaced items never contribute a blocking reason', () => {
  const reasons = getSendBlockingReasons({
    ...noBlockers,
    lineItems: [
      { description: 'Excluded item', total: null, assumption_status: 'excluded' },
      { description: 'Priced item', total: 500, assumption_status: null },
      { description: 'Unresolved Gate-2 item', total: null, assumption_status: 'unresolved', is_assumption: true },
    ],
  })
  assert.deepEqual(reasons, [])
})
