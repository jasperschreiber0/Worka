import { test } from 'node:test'
import assert from 'node:assert/strict'
// Relative .ts import for the same reason project-context.test.ts documents:
// must resolve identically under plain `node --experimental-strip-types` and
// under Next.js/webpack.
import {
  deriveQuoteReadiness,
  isSilentlyUnpriced,
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

// ─── Non-blocking estimation: conservative assumptions ─────────────────────

test('readiness: unresolved conservative assumptions are review_required, NOT blocked — the estimate is complete, just disclosed as assumed', () => {
  const r = deriveQuoteReadiness({ ...clean, unresolvedConservativeAssumptions: 2 })
  assert.equal(r.readiness, 'review_required')
  assert.deepEqual(r.blockedReasons, [])
  assert.equal(r.reviewReasons.length, 1)
  assert.match(r.reviewReasons[0], /assumed 2/)
})

test('readiness: a genuine Gate 1-3 unresolved assumption still blocks even alongside conservative assumptions — the two signals stay independent', () => {
  const r = deriveQuoteReadiness({ ...clean, unresolvedAssumptions: 1, unresolvedConservativeAssumptions: 2 })
  assert.equal(r.readiness, 'blocked')
  assert.equal(r.blockedReasons.length, 1)
  assert.equal(r.reviewReasons.length, 1) // the conservative-assumption review reason still surfaces alongside
})

test('readiness: zero conservative assumptions does not add a review reason', () => {
  const r = deriveQuoteReadiness(clean)
  assert.equal(r.reviewReasons.length, 0)
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
