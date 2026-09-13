import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pendingDocumentIds } from './document-checkpoint.ts'
test('one completed architectural file cannot unlock a seven-file estimate', () => {
  assert.deepEqual(pendingDocumentIds(['a','b','c','d','e','f','g'], ['a']), ['b','c','d','e','f','g'])
})
test('only durable completion of every queued file unlocks scope', () => {
  assert.deepEqual(pendingDocumentIds(['a','b','a'], ['b','other']), ['a'])
  assert.deepEqual(pendingDocumentIds(['a','b'], ['a','b']), [])
})

test('a fresh continuation can start a 280-second document after cached chunks', async () => {
  const { classificationBudgetRequired } = await import('./document-checkpoint.ts')
  const remaining = 340_000 - 2_529
  assert.ok(classificationBudgetRequired(280_000, 220_000, false) <= remaining)
  assert.ok(classificationBudgetRequired(280_000, 220_000, true) > remaining)
  assert.equal(classificationBudgetRequired(150_000, 220_000, false), 150_000)
})
