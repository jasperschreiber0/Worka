import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Guards against a real production incident: two independent schedulers
// (pg_cron every minute, this GitHub Actions workflow every 5 minutes)
// both invoking GET /api/cron/intake-recovery concurrently caused
// enforce_estimate_deadlines()'s `FOR UPDATE SKIP LOCKED` finalization
// loop to silently skip an eligible row for ~8h56m with zero errors. Only
// pg_cron (migration 038, database-native, tighter interval, doesn't
// degrade like GitHub Actions' own scheduler can) should fire this route
// automatically in production — this workflow stays workflow_dispatch-only
// so it's still usable for manual/targeted verification.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const workflowPath = join(repoRoot, '.github/workflows/intake-recovery-cron.yml')

test('intake-recovery-cron.yml has no automatic schedule trigger — pg_cron is the sole authority', () => {
  const contents = readFileSync(workflowPath, 'utf8')
  // A YAML `schedule:` key under `on:` is what actually arms GitHub
  // Actions' own cron scheduler; asserting its absence (not just "cron:"
  // absence, since that substring also appears in comments/paths) is what
  // proves this workflow can no longer fire on its own.
  assert.doesNotMatch(
    contents,
    /^\s*schedule:\s*$/m,
    'intake-recovery-cron.yml must not have a schedule trigger — pg_cron (migration 038) is the sole authoritative production scheduler for GET /api/cron/intake-recovery'
  )
})

test('intake-recovery-cron.yml still supports manual dispatch for targeted verification', () => {
  const contents = readFileSync(workflowPath, 'utf8')
  assert.match(
    contents,
    /^\s*workflow_dispatch:/m,
    'the workflow should remain manually triggerable even with its automatic schedule removed'
  )
})

test('other cron workflows (morning-brief, network-rates) are unaffected — still scheduled', () => {
  for (const file of ['morning-brief-cron.yml', 'network-rates-cron.yml']) {
    const contents = readFileSync(join(repoRoot, '.github/workflows', file), 'utf8')
    assert.match(
      contents,
      /^\s*schedule:\s*$/m,
      `${file} should still have its own schedule trigger — only intake-recovery-cron.yml's was removed, since it was the only one that duplicated a pg_cron-native scheduler`
    )
  }
})
