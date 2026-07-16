import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  splitIntoBatches,
  mergeFacts,
  cosineSimilarity,
  shouldGiveUp,
  gateTextExtraction,
  DEFAULT_EXTRACTION_LIMITS,
  buildDocumentProcessingJobs,
  nextRetryState,
  deriveParentBatchStatus,
  MAX_DOCUMENT_JOB_ATTEMPTS,
  selectFactsForPrompt,
  inferRelevantCategories,
  pairSupersededFacts,
  MAX_FACTS_IN_PROMPT,
  SEMANTIC_DUPLICATE_THRESHOLD,
  isRetryableApiError,
  withTimeoutAndRetry,
  documentPhaseProgress,
  type BatchableFile,
  type FactRow,
} from './pipeline-logic.ts'

// ─── splitIntoBatches ───────────────────────────────────────────────────────

test('splitIntoBatches: single file well under budget goes into one batch', () => {
  const files: BatchableFile[] = [{ fileId: '1', filename: 'a.pdf', approxBytes: 1_000_000 }]
  const { batches, excluded } = splitIntoBatches(files, 20 * 1024 * 1024, 5)
  assert.equal(batches.length, 1)
  assert.equal(batches[0].length, 1)
  assert.equal(excluded.length, 0)
})

test('splitIntoBatches: reproduces the reported 7-file case — nothing silently dropped', () => {
  // Mirrors the real report: a ~13.3MB DA doc plus two small elevations fit
  // one batch; the other four (raw sizes 1.9/3.4/3.8/2.8 MB) should now
  // land in a second batch instead of vanishing, since vision-encoded size
  // is what matters, not raw file size — approximate with a ~1.4x inflation
  // factor to keep this test independent of any specific encoding.
  const files: BatchableFile[] = [
    { fileId: 'da', filename: '16 Alfred Street Woonona - DA.pdf', approxBytes: Math.round(13.3 * 1024 * 1024 * 1.4) },
    { fileId: 'butler', filename: "Butler's Pantry Elevations.pdf", approxBytes: Math.round(0.24 * 1024 * 1024 * 1.4) },
    { fileId: 'kitchen', filename: 'Kitchen Elevation.pdf', approxBytes: Math.round(0.29 * 1024 * 1024 * 1.4) },
    { fileId: 'fittings', filename: 'DRAFT Fittings+Fixture+Appliance.pdf', approxBytes: Math.round(1.9 * 1024 * 1024 * 1.4) },
    { fileId: 'electrical', filename: 'Electrical First Draft.pdf', approxBytes: Math.round(3.4 * 1024 * 1024 * 1.4) },
    { fileId: 'materials', filename: 'DRAFT Materials + Finishes.pdf', approxBytes: Math.round(3.8 * 1024 * 1024 * 1.4) },
    { fileId: 'structurals', filename: 'Structurals 16 Alfred St.pdf', approxBytes: Math.round(2.8 * 1024 * 1024 * 1.4) },
  ]
  const { batches, excluded } = splitIntoBatches(files, 20 * 1024 * 1024, 5)

  const placedIds = batches.flat().map((f) => f.fileId)
  const excludedIds = excluded.map((f) => f.fileId)
  assert.equal(placedIds.length + excludedIds.length, files.length, 'every file is accounted for')
  assert.equal(excludedIds.length, 0, 'a bounded multi-batch run should place all 7 files, not drop any')
  assert.ok(batches.length >= 2, 'the small trade sheets should land in a second batch, not be dropped')
})

test('splitIntoBatches: a single file larger than the per-batch budget is excluded with a clear reason', () => {
  const files: BatchableFile[] = [{ fileId: 'huge', filename: 'huge.pdf', approxBytes: 25 * 1024 * 1024 }]
  const { batches, excluded } = splitIntoBatches(files, 20 * 1024 * 1024, 5)
  assert.equal(batches.length, 0)
  assert.equal(excluded.length, 1)
  assert.equal(excluded[0].fileId, 'huge')
  assert.match(excluded[0].reason, /per-batch analysis limit/)
})

test('splitIntoBatches: respects maxBatches — excess files are excluded, not dropped silently (still tracked)', () => {
  // 6 files, each just over half the budget, so only 1 fits per batch.
  const files: BatchableFile[] = Array.from({ length: 6 }, (_, i) => ({
    fileId: `f${i}`,
    filename: `f${i}.pdf`,
    approxBytes: 11 * 1024 * 1024,
  }))
  const { batches, excluded } = splitIntoBatches(files, 20 * 1024 * 1024, 3)
  assert.equal(batches.length, 3)
  assert.equal(excluded.length, 3)
  for (const e of excluded) assert.match(e.reason, /batch limit reached/)
})

test('splitIntoBatches: largest-first packing keeps the fact-richest documents in early batches', () => {
  const files: BatchableFile[] = [
    { fileId: 'small1', filename: 'small1.pdf', approxBytes: 1 * 1024 * 1024 },
    { fileId: 'big', filename: 'big.pdf', approxBytes: 15 * 1024 * 1024 },
    { fileId: 'small2', filename: 'small2.pdf', approxBytes: 1 * 1024 * 1024 },
  ]
  const { batches } = splitIntoBatches(files, 20 * 1024 * 1024, 5)
  assert.equal(batches.length, 1)
  assert.equal(batches[0][0].fileId, 'big', 'the largest file should be placed first')
})

// ─── mergeFacts ─────────────────────────────────────────────────────────────

test('mergeFacts: a new fact with the same category+key but a different value supersedes the old one', () => {
  const existing: FactRow[] = [{ id: 'e1', category: 'rooms', key: 'floor_area_m2', value: '120', evidence: null, confidence: 80 }]
  const incoming: FactRow[] = [{ category: 'rooms', key: 'floor_area_m2', value: '135', evidence: 'revised plan', confidence: 90 }]
  const result = mergeFacts(existing, incoming, 0.93)
  assert.deepEqual(result.supersededIds, ['e1'])
  assert.equal(result.mergedFacts.length, 1)
  assert.equal(result.mergedFacts[0].value, '135')
})

test('mergeFacts: identical category+key+value is not superseded (no-op restatement)', () => {
  const existing: FactRow[] = [{ id: 'e1', category: 'rooms', key: 'storeys', value: '2', evidence: null, confidence: 80 }]
  const incoming: FactRow[] = [{ category: 'rooms', key: 'storeys', value: '2', evidence: null, confidence: 85 }]
  const result = mergeFacts(existing, incoming, 0.93)
  assert.equal(result.supersededIds.length, 0)
  // Both rows remain distinct at this layer — de-duplicating identical
  // restatements is a job for a caller that wants to skip the insert,
  // not for supersession (which only fires on a genuine value change).
  assert.equal(result.mergedFacts.length, 2)
})

test('mergeFacts: semantic near-duplicate under a different key is superseded via embedding similarity', () => {
  const existing: FactRow[] = [
    { id: 'e1', category: 'rooms', key: 'gross_floor_area', value: '120sqm', evidence: null, confidence: 70, embedding: [1, 0, 0] },
  ]
  const incoming: FactRow[] = [
    { category: 'rooms', key: 'floor_area_m2', value: '120', evidence: null, confidence: 90, embedding: [0.99, 0.01, 0] },
  ]
  const result = mergeFacts(existing, incoming, 0.93)
  assert.deepEqual(result.supersededIds, ['e1'])
})

test('mergeFacts: below the semantic threshold, both facts are kept as distinct', () => {
  const existing: FactRow[] = [
    { id: 'e1', category: 'rooms', key: 'bathroom_count', value: '2', evidence: null, confidence: 70, embedding: [1, 0, 0] },
  ]
  const incoming: FactRow[] = [
    { category: 'rooms', key: 'kitchen_count', value: '1', evidence: null, confidence: 90, embedding: [0, 1, 0] },
  ]
  const result = mergeFacts(existing, incoming, 0.93)
  assert.equal(result.supersededIds.length, 0)
  assert.equal(result.mergedFacts.length, 2)
})

test('cosineSimilarity: identical vectors are similarity 1, orthogonal vectors are 0', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
})

// ─── shouldGiveUp ───────────────────────────────────────────────────────────

test('shouldGiveUp: false while within both the overall and stuck windows', () => {
  const now = 1_000_000
  assert.equal(shouldGiveUp(now, now - 5 * 60_000, now - 30_000, 15 * 60_000, 3 * 60_000), false)
})

test('shouldGiveUp: true once the overall ceiling is exceeded, even with recent progress', () => {
  const now = 1_000_000
  assert.equal(shouldGiveUp(now, now - 16 * 60_000, now - 1_000, 15 * 60_000, 3 * 60_000), true)
})

test('shouldGiveUp: true if stuck (no progress) even well within the overall ceiling', () => {
  const now = 1_000_000
  assert.equal(shouldGiveUp(now, now - 5 * 60_000, now - 4 * 60_000, 15 * 60_000, 3 * 60_000), true)
})

// ─── gateTextExtraction ─────────────────────────────────────────────────────
// Regression coverage for the incident this exists to prevent a repeat of:
// a byte-size-only gate cannot catch a small-but-expensive file (the crash
// logs named "Kitchen Elevation.pdf", ~290KB raw), and cumulative spend
// across a run must independently gate later files even when each one
// individually looks fine.

test('gateTextExtraction: a small, early file with no prior spend is allowed', () => {
  const result = gateTextExtraction(300 * 1024, 3, 0)
  assert.equal(result.skip, false)
})

test('gateTextExtraction: a small file is still skipped once the run-wide budget is already spent — the Kitchen Elevation.pdf scenario', () => {
  // ~290KB, well under maxBytes — a byte-size-only gate would wrongly allow
  // this. Simulates arriving as the 5th file after earlier files in the same
  // invocation already spent the self-imposed budget.
  const result = gateTextExtraction(290 * 1024, 3, DEFAULT_EXTRACTION_LIMITS.maxCumulativeMs)
  assert.equal(result.skip, true)
  assert.match(result.reason ?? '', /run-wide extraction budget/)
})

test('gateTextExtraction: a file over the byte-size ceiling is skipped even with no prior spend', () => {
  const result = gateTextExtraction(13.3 * 1024 * 1024, 10, 0)
  assert.equal(result.skip, true)
  assert.match(result.reason ?? '', /MB raw/)
})

test('gateTextExtraction: a file over the page-count ceiling is skipped even when small and byte-size is fine', () => {
  const result = gateTextExtraction(500 * 1024, 40, 0)
  assert.equal(result.skip, true)
  assert.match(result.reason ?? '', /pages/)
})

test('gateTextExtraction: an unknown page count (cheap pre-check failed) never blocks on its own', () => {
  const result = gateTextExtraction(500 * 1024, null, 0)
  assert.equal(result.skip, false)
})

test('gateTextExtraction: cumulative spend right at the ceiling is treated as exhausted, not right under it', () => {
  const atCeiling = gateTextExtraction(500 * 1024, 3, DEFAULT_EXTRACTION_LIMITS.maxCumulativeMs)
  const justUnder = gateTextExtraction(500 * 1024, 3, DEFAULT_EXTRACTION_LIMITS.maxCumulativeMs - 1)
  assert.equal(atCeiling.skip, true)
  assert.equal(justUnder.skip, false)
})

// ─── Document processing queue (worker model) ──────────────────────────────
// Requirement 1: multiple PDFs create multiple jobs.

test('buildDocumentProcessingJobs: one job row per document, all pending with zero attempts', () => {
  const parentJobId = 'batch-1'
  const documentIds = ['doc-1', 'doc-2', 'doc-3', 'doc-4', 'doc-5', 'doc-6', 'doc-7']
  const jobs = buildDocumentProcessingJobs(parentJobId, documentIds)
  assert.equal(jobs.length, 7)
  for (const [i, job] of Array.from(jobs.entries())) {
    assert.equal(job.parentJobId, parentJobId)
    assert.equal(job.documentId, documentIds[i])
    assert.equal(job.status, 'pending')
    assert.equal(job.attempts, 0)
  }
})

// Requirement 2: two workers cannot claim the same job. This guarantee is
// enforced at the database layer (claim_next_document_job in migration
// 034 uses `FOR UPDATE SKIP LOCKED`, which makes two concurrent claimants
// for the same parent physically unable to receive the same row) — no
// pure-JS unit test can exercise real Postgres row locking, so this is a
// regression guard on the SQL itself rather than a behavioral test: it
// fails loudly if that clause is ever accidentally dropped from the
// migration, which would silently reintroduce the double-claim race.
test('claim_next_document_job: migration enforces FOR UPDATE SKIP LOCKED for atomic claiming', () => {
  const migrationPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '034_document_processing_jobs.sql')
  const sql = readFileSync(migrationPath, 'utf-8')
  assert.match(sql, /FOR UPDATE SKIP LOCKED/)
  assert.match(sql, /CREATE OR REPLACE FUNCTION claim_next_document_job/)
})

// Requirement 3 & 4: failed document retries correctly, third failure marks failed.

test('nextRetryState: 1st failure schedules a retry with a 30s delay', () => {
  const result = nextRetryState(0)
  assert.deepEqual(result, { status: 'pending', attempts: 1, delayMs: 30_000 })
})

test('nextRetryState: 2nd failure schedules a retry with a 2min delay', () => {
  const result = nextRetryState(1)
  assert.deepEqual(result, { status: 'pending', attempts: 2, delayMs: 120_000 })
})

test('nextRetryState: 3rd failure marks the document permanently failed, no further delay', () => {
  const result = nextRetryState(2)
  assert.deepEqual(result, { status: 'failed', attempts: 3, delayMs: null })
  assert.equal(result.attempts, MAX_DOCUMENT_JOB_ATTEMPTS)
})

// Requirement 5 & 6: parent completes only when all children are terminal;
// one failed PDF does not fail the entire batch.

test('deriveParentBatchStatus: running while any child is still pending or running', () => {
  assert.equal(deriveParentBatchStatus(['completed', 'pending', 'completed']), 'running')
  assert.equal(deriveParentBatchStatus(['completed', 'running']), 'running')
})

test('deriveParentBatchStatus: all completed with no failures is a clean completed', () => {
  assert.equal(deriveParentBatchStatus(['completed', 'completed', 'completed']), 'completed')
})

test('deriveParentBatchStatus: one failed document among otherwise-completed ones does not fail the batch', () => {
  assert.equal(deriveParentBatchStatus(['completed', 'completed', 'failed', 'completed']), 'completed_with_failures')
})

test('deriveParentBatchStatus: every child failed is a genuine batch failure', () => {
  assert.equal(deriveParentBatchStatus(['failed', 'failed']), 'failed')
})

// ─── selectFactsForPrompt ───────────────────────────────────────────────────
// Regression coverage for the architecture-review finding: a prior version
// of chat's context builder queried active+superseded facts together,
// ORDER BY created_at DESC LIMIT 200, before splitting them — so an old
// but still-active, high-confidence fact could be evicted by recency
// alone before truncation ever considered confidence. selectFactsForPrompt
// must never do that: no created_at anywhere in its logic.

function fact(overrides: Partial<FactRow> & { category: string; key: string; value: string; confidence: number }): FactRow {
  return { evidence: null, ...overrides }
}

test('selectFactsForPrompt: below the cap, returns every fact unchanged (no truncation)', () => {
  const facts = [fact({ category: 'rooms', key: 'a', value: '1', confidence: 10 })]
  const result = selectFactsForPrompt(facts, 5)
  assert.equal(result.length, 1)
  assert.deepEqual(result, facts)
})

test('selectFactsForPrompt: over the cap with no relevance hint, keeps the highest-confidence facts regardless of order given', () => {
  const facts = [
    fact({ category: 'rooms', key: 'old_high_confidence', value: 'x', confidence: 95 }),
    fact({ category: 'rooms', key: 'newer_low_confidence', value: 'y', confidence: 20 }),
    fact({ category: 'rooms', key: 'mid', value: 'z', confidence: 60 }),
  ]
  const result = selectFactsForPrompt(facts, 2)
  assert.equal(result.length, 2)
  assert.deepEqual(result.map((f) => f.key), ['old_high_confidence', 'mid'])
})

test('selectFactsForPrompt: a relevant-category fact is promoted ahead of a higher-confidence irrelevant one when truncating', () => {
  const facts = [
    fact({ category: 'services', key: 'electrical_spec', value: 'x', confidence: 90 }),
    fact({ category: 'finishes', key: 'floor_type', value: 'polished concrete', confidence: 55 }),
  ]
  // Without relevance: electrical (90) beats flooring (55).
  assert.deepEqual(selectFactsForPrompt(facts, 1).map((f) => f.key), ['electrical_spec'])
  // With "finishes" inferred as relevant: flooring is kept despite lower confidence.
  assert.deepEqual(selectFactsForPrompt(facts, 1, new Set(['finishes'])).map((f) => f.key), ['floor_type'])
})

test('selectFactsForPrompt: within the same relevance tier, confidence still breaks ties', () => {
  const facts = [
    fact({ category: 'finishes', key: 'low', value: 'a', confidence: 40 }),
    fact({ category: 'finishes', key: 'high', value: 'b', confidence: 80 }),
  ]
  assert.deepEqual(selectFactsForPrompt(facts, 1, new Set(['finishes'])).map((f) => f.key), ['high'])
})

test('selectFactsForPrompt: default cap matches MAX_FACTS_IN_PROMPT', () => {
  const facts = Array.from({ length: MAX_FACTS_IN_PROMPT + 5 }, (_, i) =>
    fact({ category: 'rooms', key: `k${i}`, value: 'v', confidence: i }))
  assert.equal(selectFactsForPrompt(facts).length, MAX_FACTS_IN_PROMPT)
})

// Direct coverage of idTiebreak itself — the prior tests only exercise
// confidence breaking a relevance tie, never two facts tied on BOTH
// relevance and confidence, which is the actual case idTiebreak exists
// for (flagged as an untested code path in the hardening-pass review).
test('selectFactsForPrompt: facts tied on both relevance and confidence resolve by ascending id, deterministically', () => {
  const facts = [
    fact({ category: 'finishes', key: 'b', value: '2', confidence: 90, id: 'zzz' }),
    fact({ category: 'finishes', key: 'a', value: '1', confidence: 90, id: 'aaa' }),
  ]
  const result = selectFactsForPrompt(facts, 1, new Set(['finishes']))
  assert.deepEqual(result.map((f) => f.id), ['aaa'], 'the lower id should win the tie')

  // Same input, called repeatedly (simulating rows arriving in a different
  // order across executions) — the outcome must not depend on input order.
  const reordered = [facts[1], facts[0]]
  assert.deepEqual(
    selectFactsForPrompt(reordered, 1, new Set(['finishes'])).map((f) => f.id),
    ['aaa'],
  )
})

test('selectFactsForPrompt: a fact with no id sorts after one with an id, when otherwise tied', () => {
  const facts = [
    fact({ category: 'rooms', key: 'a', value: '1', confidence: 90 }), // no id
    fact({ category: 'rooms', key: 'b', value: '2', confidence: 90, id: 'has-id' }),
  ]
  assert.deepEqual(selectFactsForPrompt(facts, 1).map((f) => f.id), ['has-id'])
})

// ─── inferRelevantCategories ────────────────────────────────────────────────

test('inferRelevantCategories: matches a known trade keyword', () => {
  const hits = inferRelevantCategories('what flooring is required for the kitchen')
  assert.ok(hits.has('finishes'))
  assert.ok(hits.has('kitchens'))
})

test('inferRelevantCategories: no keyword match returns an empty set, not a guess', () => {
  const hits = inferRelevantCategories('is everything on track')
  assert.equal(hits.size, 0)
})

// ─── pairSupersededFacts ────────────────────────────────────────────────────
// Regression coverage for the architecture-review finding: read-side
// change detection previously only matched exact category+key, a strictly
// weaker guarantee than mergeFacts' write-side semantic-similarity check.

test('pairSupersededFacts: exact category+key match pairs old value with its replacement', () => {
  const active: FactRow[] = [fact({ category: 'rooms', key: 'floor_area_m2', value: '135', confidence: 90 })]
  const superseded: FactRow[] = [fact({ category: 'rooms', key: 'floor_area_m2', value: '120', confidence: 80 })]
  const changes = pairSupersededFacts(active, superseded)
  assert.deepEqual(changes, [{ category: 'rooms', key: 'floor_area_m2', oldValue: '120', newValue: '135' }])
})

test('pairSupersededFacts: semantic near-duplicate under a different key is paired via embeddings, matching mergeFacts', () => {
  const active: FactRow[] = [
    fact({ category: 'rooms', key: 'floor_area_m2', value: '120', confidence: 90, embedding: [0.99, 0.01, 0] }),
  ]
  const superseded: FactRow[] = [
    fact({ category: 'rooms', key: 'gross_floor_area', value: '110sqm', confidence: 70, embedding: [1, 0, 0] }),
  ]
  const changes = pairSupersededFacts(active, superseded, SEMANTIC_DUPLICATE_THRESHOLD)
  assert.deepEqual(changes, [{ category: 'rooms', key: 'floor_area_m2', oldValue: '110sqm', newValue: '120' }])
})

test('pairSupersededFacts: below the semantic threshold and no exact key match, no pairing is invented', () => {
  const active: FactRow[] = [fact({ category: 'rooms', key: 'bathroom_count', value: '2', confidence: 90, embedding: [1, 0, 0] })]
  const superseded: FactRow[] = [fact({ category: 'rooms', key: 'kitchen_count', value: '1', confidence: 70, embedding: [0, 1, 0] })]
  assert.deepEqual(pairSupersededFacts(active, superseded), [])
})

test('pairSupersededFacts: respects maxChanges', () => {
  const active: FactRow[] = Array.from({ length: 5 }, (_, i) => fact({ category: 'rooms', key: `k${i}`, value: 'new', confidence: 90 }))
  const superseded: FactRow[] = Array.from({ length: 5 }, (_, i) => fact({ category: 'rooms', key: `k${i}`, value: 'old', confidence: 70 }))
  assert.equal(pairSupersededFacts(active, superseded, SEMANTIC_DUPLICATE_THRESHOLD, 2).length, 2)
})

// Genuine 3-generation chain (v1 -> v2 -> v3, only v3 active) — the exact
// scenario the architecture review flagged as having zero direct test
// coverage. supersededFacts here is ordered most-recently-superseded
// first (v2 before v1), matching the hard precondition documented on
// pairSupersededFacts and on buildSupersededFactsQuerySpec in
// lib/project-context.ts (ORDER BY created_at DESC).
test('pairSupersededFacts: a v1->v2->v3 chain collapses to one change (v2->v3), not two', () => {
  const active: FactRow[] = [fact({ category: 'rooms', key: 'floor_area_m2', value: '150', confidence: 95 })] // v3
  const superseded: FactRow[] = [
    fact({ category: 'rooms', key: 'floor_area_m2', value: '135', confidence: 85 }), // v2 (most recently superseded)
    fact({ category: 'rooms', key: 'floor_area_m2', value: '120', confidence: 75 }), // v1 (oldest)
  ]
  const changes = pairSupersededFacts(active, superseded)
  assert.equal(changes.length, 1, 'only one change should be reported, not one per historical version')
  assert.deepEqual(changes[0], { category: 'rooms', key: 'floor_area_m2', oldValue: '135', newValue: '150' })
  // v1 (120) must not appear anywhere in the output — this is the
  // documented, schema-forced limitation: the full lineage isn't
  // reconstructable without a superseded_by_id column, so the oldest
  // generation is dropped entirely rather than shown as a second change.
  assert.ok(!changes.some((c) => c.oldValue === '120'))
})

test('pairSupersededFacts: chain collapsing is order-dependent on its documented precondition (most-recent-first)', () => {
  const active: FactRow[] = [fact({ category: 'rooms', key: 'floor_area_m2', value: '150', confidence: 95 })]
  // Deliberately passed oldest-first (v1 before v2) — violates the
  // documented precondition. This test exists to make that dependency
  // explicit: the function has no way to detect the violation, it just
  // silently reports the wrong predecessor (v1, not v2) as "most recent".
  const oldestFirst: FactRow[] = [
    fact({ category: 'rooms', key: 'floor_area_m2', value: '120', confidence: 75 }), // v1
    fact({ category: 'rooms', key: 'floor_area_m2', value: '135', confidence: 85 }), // v2
  ]
  const changes = pairSupersededFacts(active, oldestFirst)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].oldValue, '120', 'with the precondition violated, the function reports v1 as if it were the most recent predecessor')
})

// ─── isRetryableApiError / withTimeoutAndRetry ─────────────────────────────

test('isRetryableApiError: abort (timeout), 429, and 5xx are retryable', () => {
  const abortErr = new Error('The operation was aborted')
  abortErr.name = 'AbortError'
  assert.equal(isRetryableApiError(abortErr), true)
  assert.equal(isRetryableApiError({ status: 429 }), true)
  assert.equal(isRetryableApiError({ status: 500 }), true)
  assert.equal(isRetryableApiError({ status: 529 }), true, '529 overloaded_error is >= 500')
})

test('isRetryableApiError: 400/401/404 and plain errors are not retryable', () => {
  assert.equal(isRetryableApiError({ status: 400 }), false)
  assert.equal(isRetryableApiError({ status: 401 }), false)
  assert.equal(isRetryableApiError(new Error('boom')), false)
  assert.equal(isRetryableApiError(null), false)
})

test('withTimeoutAndRetry: returns the result on first success, no retry', async () => {
  let calls = 0
  const result = await withTimeoutAndRetry(async () => { calls++; return 'ok' }, { maxRetries: 2 })
  assert.equal(result, 'ok')
  assert.equal(calls, 1)
})

test('withTimeoutAndRetry: retries a transient failure then succeeds', async () => {
  let calls = 0
  const failures: Array<{ attempt: number; retryable: boolean }> = []
  const result = await withTimeoutAndRetry(
    async () => {
      calls++
      if (calls < 2) { const err = { status: 500 }; throw err }
      return 'ok'
    },
    {
      maxRetries: 2,
      onAttemptFailed: (info) => failures.push({ attempt: info.attempt, retryable: info.retryable }),
    },
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 2)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].retryable, true)
})

test('withTimeoutAndRetry: a non-retryable error throws immediately without retrying', async () => {
  let calls = 0
  await assert.rejects(
    withTimeoutAndRetry(async () => { calls++; throw { status: 400 } }, { maxRetries: 3 }),
  )
  assert.equal(calls, 1)
})

test('withTimeoutAndRetry: exhausting all retries rethrows the last error', async () => {
  let calls = 0
  await assert.rejects(
    withTimeoutAndRetry(async () => { calls++; throw { status: 503 } }, { maxRetries: 2 }),
    (err: unknown) => {
      assert.deepEqual(err, { status: 503 })
      return true
    },
  )
  assert.equal(calls, 3) // initial attempt + 2 retries
})

// ─── documentPhaseProgress ─────────────────────────────────────────────────

test('documentPhaseProgress: starts at 5% with nothing processed', () => {
  const { pct, message } = documentPhaseProgress(0, 7)
  assert.equal(pct, 5)
  assert.match(message, /0 of 7/)
})

test('documentPhaseProgress: advances proportionally and caps at 20% fully done', () => {
  assert.equal(documentPhaseProgress(3, 7).pct, 11)
  const done = documentPhaseProgress(7, 7)
  assert.equal(done.pct, 20, 'full completion must stay below classification\'s first real write (25%)')
  assert.match(done.message, /7 of 7/)
})

test('documentPhaseProgress: single-document upload gets singular phrasing, terminal count clamps', () => {
  assert.match(documentPhaseProgress(0, 1).message, /your document/)
  // Defensive: a terminal count above total (shouldn't happen, but a race
  // between two polls could momentarily disagree) never exceeds the cap.
  assert.equal(documentPhaseProgress(9, 7).pct, 20)
  // Zero/absent totals degrade to the initial state rather than dividing by zero.
  assert.equal(documentPhaseProgress(0, 0).pct, 5)
})

test('withTimeoutAndRetry: aborts the call via the signal once timeoutMs elapses', async () => {
  const result = await withTimeoutAndRetry(
    (signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }).catch((e) => { throw e }),
    { timeoutMs: 10, maxRetries: 0 },
  ).catch((e) => e)
  assert.equal((result as Error).name, 'AbortError')
})
