import assert from 'node:assert/strict'
import test from 'node:test'
import { createXeroOAuthState, verifyXeroOAuthState } from './xero-oauth-state.ts'

process.env.XERO_OAUTH_STATE_SECRET = 'test-only-secret'

test('Xero OAuth state is bound to the builder and verifies when fresh', () => {
  const now = Date.parse('2026-09-07T00:00:00Z')
  const state = createXeroOAuthState('builder-a', now)
  assert.equal(verifyXeroOAuthState(state, 'builder-a', now + 1_000), true)
  assert.equal(verifyXeroOAuthState(state, 'builder-b', now + 1_000), false)
})

test('Xero OAuth state rejects tampering, replay age, and future timestamps', () => {
  const now = Date.parse('2026-09-07T00:00:00Z')
  const state = createXeroOAuthState('builder-a', now)
  const parts = state.split('.')
  parts[2] = 'tampered'
  assert.equal(verifyXeroOAuthState(parts.join('.'), 'builder-a', now), false)
  assert.equal(verifyXeroOAuthState(state, 'builder-a', now + 10 * 60 * 1000 + 1), false)
  assert.equal(verifyXeroOAuthState(createXeroOAuthState('builder-a', now + 60_000), 'builder-a', now), false)
})
