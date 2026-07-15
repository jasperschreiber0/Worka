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
  for (const [i, job] of jobs.entries()) {
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
