import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  splitIntoBatches,
  mergeFacts,
  cosineSimilarity,
  shouldGiveUp,
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
