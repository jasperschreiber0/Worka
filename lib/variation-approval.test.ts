import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldLogContractApplicationFailure,
  describeApprovalOutcome,
  canRetryContractApplication,
} from './variation-approval.ts'

// ─── shouldLogContractApplicationFailure ────────────────────────────────────

test('shouldLogContractApplicationFailure: applied:true -- normal success, nothing to log', () => {
  assert.equal(
    shouldLogContractApplicationFailure('approved', { applied: true }),
    false
  )
})

test('shouldLogContractApplicationFailure: applied:false -- must log', () => {
  assert.equal(
    shouldLogContractApplicationFailure('approved', { applied: false, reason: 'This job has no active estimate to apply the variation to.' }),
    true
  )
})

test('shouldLogContractApplicationFailure: missing active quote reason -- still must log (a specific case of applied:false)', () => {
  assert.equal(
    shouldLogContractApplicationFailure('approved', { applied: false, reason: 'This job has no active estimate to apply the variation to.' }),
    true
  )
})

test('shouldLogContractApplicationFailure: rejected decision -- never logs, no contract application was ever attempted', () => {
  assert.equal(shouldLogContractApplicationFailure('rejected', null), false)
  assert.equal(shouldLogContractApplicationFailure('rejected', { applied: false, reason: 'x' }), false)
})

test('shouldLogContractApplicationFailure: approved with no contractEffect at all (null/undefined) -- nothing to log', () => {
  assert.equal(shouldLogContractApplicationFailure('approved', null), false)
  assert.equal(shouldLogContractApplicationFailure('approved', undefined), false)
})

// ─── describeApprovalOutcome ─────────────────────────────────────────────────

test('describeApprovalOutcome: approved + applied:true -- approved_and_applied (normal success)', () => {
  assert.equal(describeApprovalOutcome('approved', { applied: true }), 'approved_and_applied')
})

test('describeApprovalOutcome: approved + applied:false -- approved_but_not_applied, never claims the contract changed', () => {
  assert.equal(
    describeApprovalOutcome('approved', { applied: false, reason: 'This job has no active estimate to apply the variation to.' }),
    'approved_but_not_applied'
  )
})

test('describeApprovalOutcome: approved + no contractEffect (e.g. a page reload with no fresh response) -- defaults to applied, never to a false warning', () => {
  assert.equal(describeApprovalOutcome('approved', null), 'approved_and_applied')
})

test('describeApprovalOutcome: rejected -- always "rejected" regardless of any contractEffect value', () => {
  assert.equal(describeApprovalOutcome('rejected', null), 'rejected')
  assert.equal(describeApprovalOutcome('rejected', { applied: false, reason: 'x' }), 'rejected')
})

// ─── canRetryContractApplication ────────────────────────────────────────────

test('canRetryContractApplication: approved with no existing line item -- safe to retry', () => {
  assert.equal(canRetryContractApplication('approved', false), true)
})

test('canRetryContractApplication: approved but a line item already exists -- do not retry (already applied, retrying would be redundant, not unsafe, but nothing to do)', () => {
  assert.equal(canRetryContractApplication('approved', true), false)
})

test('canRetryContractApplication: not yet approved (draft/pending) -- never retry, this is not the approval action', () => {
  assert.equal(canRetryContractApplication('draft', false), false)
  assert.equal(canRetryContractApplication('pending', false), false)
})

test('canRetryContractApplication: rejected -- never retry', () => {
  assert.equal(canRetryContractApplication('rejected', false), false)
})
