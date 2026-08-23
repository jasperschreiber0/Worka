import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Regression guard for migration 095: GET /api/cron/intake-recovery already
// computed summary.deadlines_enforced (the count of estimate_runs rows
// enforce_estimate_deadlines() actually finalized this tick) but never
// wrote it into the intake_recovery_runs audit row — diagnosing an
// 8h56m-stuck row required six separate live diagnostic queries specifically
// because that count was invisible after the fact. This route has no
// database available to this test suite (it's a Next.js API route calling
// Supabase directly, out of scope for the pure-function unit tests
// documented in CLAUDE.md), so this asserts the fix at the source level:
// the exact property must be present in the object passed to
// `.insert(...)`, and every pre-existing metric it must not have
// displaced must still be there too.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const routePath = join(repoRoot, 'app/api/cron/intake-recovery/route.ts')
const routeSource = readFileSync(routePath, 'utf8')

function extractInsertBlock(source: string): string {
  const marker = "from('intake_recovery_runs').insert({"
  const start = source.indexOf(marker)
  assert.ok(start !== -1, 'expected an intake_recovery_runs insert call in route.ts')
  const openBrace = source.indexOf('{', start + marker.length - 1)
  let depth = 0
  let i = openBrace
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return source.slice(openBrace, i + 1)
}

test('the intake_recovery_runs insert persists deadlines_enforced', () => {
  const block = extractInsertBlock(routeSource)
  assert.match(
    block,
    /deadlines_enforced:\s*summary\.deadlines_enforced/,
    'deadlines_enforced must be persisted from summary.deadlines_enforced, not silently dropped'
  )
})

test('the intake_recovery_runs insert still persists every pre-existing recovery metric', () => {
  const block = extractInsertBlock(routeSource)
  const preExistingFields = [
    'document_jobs_reclaimed',
    'stalled_batches_recomputed',
    'batches_resumed',
    'stale_locks_released',
    'abandoned_files_marked_failed',
    'job_locks_reclaimed',
    'stuck_files_retried',
    'files_permanently_failed',
    'errors',
  ]
  for (const field of preExistingFields) {
    assert.match(
      block,
      new RegExp(`\\b${field}:`),
      `${field} must still be persisted — the deadlines_enforced fix must not have displaced an existing metric`
    )
  }
})
