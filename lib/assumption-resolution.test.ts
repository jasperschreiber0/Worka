import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLineItemUpdate,
  allAssumptionsResolved,
  shouldRecordAssumptionAsResolved,
  resolveQuoteStatusAfterTransitionAttempt,
} from './assumption-resolution.ts'

// ─── buildLineItemUpdate ─────────────────────────────────────────────────────

test('buildLineItemUpdate: accepted -- only assumption_status changes', () => {
  const update = buildLineItemUpdate('accepted', { priorRate: 45 })
  assert.deepEqual(update, { assumption_status: 'accepted' })
})

test('buildLineItemUpdate: adjusted with a known rate -- quantity, unit, and total all set', () => {
  const update = buildLineItemUpdate('adjusted', { adjustedQuantity: 12, adjustedUnit: 'm2', priorRate: 45 })
  assert.deepEqual(update, { assumption_status: 'adjusted', quantity: 12, unit: 'm2', total: 540 })
})

test('buildLineItemUpdate: adjusted with no rate yet -- total is left unset, not zero', () => {
  const update = buildLineItemUpdate('adjusted', { adjustedQuantity: 12, adjustedUnit: 'm2', priorRate: null })
  assert.deepEqual(update, { assumption_status: 'adjusted', quantity: 12, unit: 'm2' })
  assert.equal('total' in update, false)
})

test('buildLineItemUpdate: adjusted with no unit change supplied -- unit key omitted, not overwritten with undefined', () => {
  const update = buildLineItemUpdate('adjusted', { adjustedQuantity: 8, priorRate: 10 })
  assert.deepEqual(update, { assumption_status: 'adjusted', quantity: 8, total: 80 })
})

test('buildLineItemUpdate: excluded -- forces is_assumption true and assumption_status excluded regardless of quantities', () => {
  const update = buildLineItemUpdate('excluded', { priorRate: 45 })
  assert.deepEqual(update, { assumption_status: 'excluded', is_assumption: true })
})

// ─── allAssumptionsResolved ──────────────────────────────────────────────────

test('allAssumptionsResolved: empty list is never "all resolved" (nothing to advance on)', () => {
  assert.equal(allAssumptionsResolved([]), false)
})

test('allAssumptionsResolved: every assumption has a real resolution_type -> true', () => {
  assert.equal(
    allAssumptionsResolved([{ resolution_type: 'accepted' }, { resolution_type: 'excluded' }]),
    true
  )
})

test('allAssumptionsResolved: one null resolution_type (never resolved, or its line-item write failed and was never recorded) -> false', () => {
  assert.equal(
    allAssumptionsResolved([{ resolution_type: 'accepted' }, { resolution_type: null }]),
    false
  )
})

test('allAssumptionsResolved: a lingering "unresolved" value -> false', () => {
  assert.equal(
    allAssumptionsResolved([{ resolution_type: 'accepted' }, { resolution_type: 'unresolved' }]),
    false
  )
})

// ─── shouldRecordAssumptionAsResolved: the core invariant gate ─────────────

test('shouldRecordAssumptionAsResolved: no linked line item -- nothing to wait on, safe to record immediately', () => {
  assert.equal(shouldRecordAssumptionAsResolved(null), true)
})

test('shouldRecordAssumptionAsResolved: line-item write succeeded -- safe to record', () => {
  assert.equal(shouldRecordAssumptionAsResolved({ error: null }), true)
})

test('shouldRecordAssumptionAsResolved: line-item write failed -- must NOT record the resolution (the core invariant)', () => {
  assert.equal(shouldRecordAssumptionAsResolved({ error: { message: 'connection reset' } }), false)
})

// ─── resolveQuoteStatusAfterTransitionAttempt ───────────────────────────────

test('resolveQuoteStatusAfterTransitionAttempt: this call won the draft -> pending_review transition -- its own returned status is authoritative', () => {
  const status = resolveQuoteStatusAfterTransitionAttempt({ data: { status: 'pending_review' } }, null)
  assert.equal(status, 'pending_review')
})

test('resolveQuoteStatusAfterTransitionAttempt: 0 rows matched because it was already pending_review (a retry) -- reports the true current status, not an assumed success', () => {
  const status = resolveQuoteStatusAfterTransitionAttempt({ data: null }, 'pending_review')
  assert.equal(status, 'pending_review')
})

test('resolveQuoteStatusAfterTransitionAttempt: 0 rows matched and the write genuinely failed -- reports the true current status (draft), never a false pending_review', () => {
  const status = resolveQuoteStatusAfterTransitionAttempt({ data: null }, 'draft')
  assert.equal(status, 'draft')
})

test('resolveQuoteStatusAfterTransitionAttempt: 0 rows matched and even the re-check read failed -- falls back to the conservative "draft", never fabricates pending_review', () => {
  const status = resolveQuoteStatusAfterTransitionAttempt({ data: null }, null)
  assert.equal(status, 'draft')
})
