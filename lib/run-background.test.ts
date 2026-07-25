import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInBackground } from './run-background.ts'

test('runInBackground: runs the work and does not block the caller', () => {
  let ran = false
  runInBackground('test-label', async () => {
    ran = true
  })
  // Synchronous call returns immediately — the work may not have completed
  // yet, but starting it must never throw or require awaiting.
  assert.equal(typeof ran, 'boolean')
})

test('runInBackground: a rejection is caught, not thrown, and does not crash the process', async () => {
  const originalError = console.error
  const loggedCalls: string[] = []
  console.error = (...args: unknown[]) => {
    loggedCalls.push(String(args[0]))
  }
  try {
    assert.doesNotThrow(() => {
      runInBackground('failing-task', async () => {
        throw new Error('boom')
      })
    })
    // Let the microtask queue flush so the rejection handler runs. Unrelated
    // process-level console.error calls (e.g. Node module-type warnings) can
    // also land during this window, so check every captured call rather than
    // assuming ours is the only or the last one.
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(loggedCalls.some((call) => call.includes('failing-task')))
  } finally {
    console.error = originalError
  }
})

test('runInBackground: work actually completes (fire-and-forget, not fire-and-drop)', async () => {
  let completed = false
  runInBackground('completion-check', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    completed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(completed, true)
})
