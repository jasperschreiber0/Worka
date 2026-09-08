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
