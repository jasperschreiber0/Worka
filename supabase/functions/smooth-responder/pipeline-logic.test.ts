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
  documentDisplayState,
  selectFactsBalancedBySource,
  summarizeFactSelection,
  classifyAnthropicError,
  isRetryableClassification,
  isBillingHaltClassification,
  maxConsecutiveOccurrences,
  shouldStopRetrying,
  nextFailureHistory,
  splitBatchForRetry,
  dedupeRealFileIds,
  formatWallClockStallReason,
  truncateEvidence,
  formatFactForScopePrompt,
  STAGE3_MAX_EVIDENCE_CHARS,
  shouldChunkTradeReasoning,
  desiredStage3ChunkCount,
  STAGE3_TRADE_CHUNK_FACT_THRESHOLD,
  STAGE3_LARGE_PROJECT_FACT_THRESHOLD,
  STAGE3_LARGE_PROJECT_CHUNK_COUNT,
  splitTradeCategoriesIntoChunks,
  planStage3Chunks,
  STAGE3_PER_CALL_TIMEOUT_MS,
  STAGE3_DEFAULT_CHUNK_COUNT,
  mergeScopeReasoningResults,
  shouldSkipStage3Call,
  nextStage3FailureHistory,
  shouldSkipStage6Call,
  nextStage6FailureHistory,
  sha256Hex,
  decideDuplicateFile,
  filterToCanonicalHashCandidates,
  partitionCompletedJobsForClassification,
  buildConservativeAssumption,
  capConfidenceForBlockingTrade,
  conservativeAssumptionAppliesToTrade,
  BLOCKING_ASSUMPTION_CONFIDENCE_CAP,
  BLOCKING_ASSUMPTION_CONFIDENCE_PENALTY,
  CONSERVATIVE_ASSUMPTION_FALLBACK,
  buildProjectModel,
  buildTradeViews,
  viewsForTradeCategory,
  formatTradeViewsForPrompt,
  TRADE_VIEW_NAMES,
  TRADE_CATEGORY_TO_VIEWS,
  findMissingTrades,
  lineItemKey,
  filterNewLineItems,
  buildTradeRecoveryPrompt,
  buildTradeRecoveryReport,
  isTruncatedResponseError,
  shouldRetryTradeRecovery,
  callWithTradeRecoveryRetry,
  TRUNCATED_RESPONSE_PREFIX,
  TRADE_RECOVERY_INITIAL_MAX_TOKENS,
  TRADE_RECOVERY_RETRY_MAX_TOKENS,
  type TradeViewName,
  type BatchableFile,
  type FactRow,
  type Stage3FailureHistory,
  type Stage6FailureHistory,
  type HashedFileCandidate,
  type CompletedDocumentJobRow,
  type ConservativeAssumption,
  type BucketableFact,
  type TradeRecoveryResult,
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
  // ...and the caller is now told exactly which incoming facts are those
  // restatements, so the redundant insert can be skipped (a document
  // uploaded twice must not double its own weight in the fact budget).
  assert.deepEqual(result.duplicateNewFactIndexes, [0])
})

test('mergeFacts: a genuinely new fact is not flagged as a duplicate', () => {
  const existing: FactRow[] = [{ id: 'e1', category: 'rooms', key: 'storeys', value: '2', evidence: null, confidence: 80 }]
  const incoming: FactRow[] = [
    { category: 'rooms', key: 'storeys', value: '2', evidence: null, confidence: 85 },        // restatement
    { category: 'finishes', key: 'benchtop', value: 'stone 40mm', evidence: null, confidence: 90 }, // new
    { category: 'rooms', key: 'storeys', value: '3', evidence: null, confidence: 88 },        // conflict
  ]
  const result = mergeFacts(existing, incoming, 0.93)
  assert.deepEqual(result.duplicateNewFactIndexes, [0])
  assert.deepEqual(result.supersededIds, ['e1'])
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

// ─── selectFactsBalancedBySource ────────────────────────────────────────────
// Regression coverage for the multi-document trust failure: global
// confidence-ordered truncation deleted a scanned engineering document's
// ENTIRE contribution (0% survival) once the fact base crossed the cap,
// because scan readability depressed its confidence scores. Every source
// document must be guaranteed representation.

function factsFrom(source: string | null, count: number, confidence: number): FactRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${source ?? 'none'}-${String(i).padStart(3, '0')}`,
    category: 'cat', key: `${source}-k${i}`, value: `v${i}`,
    confidence, source_document_id: source,
  }))
}

test('balanced: under the cap, every fact passes through untouched', () => {
  const facts = [...factsFrom('doc-a', 10, 90), ...factsFrom('doc-b', 5, 40)]
  assert.equal(selectFactsBalancedBySource(facts, 200).length, 15)
})

test('balanced: the scanned-engineering scenario — low-confidence document survives the cap', () => {
  // 7 sources, 300 facts, engineering scanned at confidence 45 — the exact
  // shape that produced 0% survival under global confidence ordering.
  const facts = [
    ...factsFrom('plans', 60, 85),
    ...factsFrom('spec', 70, 80),
    ...factsFrom('fixtures', 45, 90),
    ...factsFrom('finishes', 40, 82),
    ...factsFrom('electrical', 35, 78),
    ...factsFrom('engineering', 30, 45), // scanned
    ...factsFrom('plumbing', 20, 76),
  ]
  const kept = selectFactsBalancedBySource(facts, 200)
  assert.equal(kept.length, 200)
  const engineeringKept = kept.filter((f) => f.source_document_id === 'engineering').length
  // floor = 200/7 = 28 — engineering is guaranteed its highest-confidence 28
  assert.ok(engineeringKept >= 28, `engineering must keep at least its floor, got ${engineeringKept}`)
  // and the old behavior is confirmed dead: it can no longer be zero
  assert.ok(engineeringKept > 0)
})

test('balanced: remaining budget still goes to the highest-confidence facts', () => {
  const facts = [...factsFrom('big', 150, 95), ...factsFrom('small', 10, 30)]
  const kept = selectFactsBalancedBySource(facts, 100)
  assert.equal(kept.length, 100)
  const small = kept.filter((f) => f.source_document_id === 'small').length
  // floor = 100/2 = 50, but small only has 10 — all 10 kept, the other 90
  // slots go to big's higher-confidence facts, not wasted.
  assert.equal(small, 10)
  assert.equal(kept.filter((f) => f.source_document_id === 'big').length, 90)
})

test('balanced: builder answers (no source document) form their own protected group', () => {
  const facts = [...factsFrom('doc-a', 250, 90), ...factsFrom(null, 5, 100)]
  const kept = selectFactsBalancedBySource(facts, 200)
  assert.equal(kept.filter((f) => f.source_document_id === null).length, 5)
})

test('balanced: 20-document upload — no source disappears', () => {
  const facts: FactRow[] = []
  for (let d = 0; d < 20; d++) {
    facts.push(...factsFrom(`doc-${String(d).padStart(2, '0')}`, 20, 50 + d * 2))
  }
  const kept = selectFactsBalancedBySource(facts, 200)
  assert.equal(kept.length, 200)
  const sources = new Set(kept.map((f) => f.source_document_id))
  assert.equal(sources.size, 20, 'every one of 20 documents must contribute')
  // floor = 200/20 = 10 — each document keeps at least its floor
  for (const s of Array.from(sources)) {
    assert.ok(kept.filter((f) => f.source_document_id === s).length >= 10)
  }
})

test('balanced: deterministic — same input always selects the same facts', () => {
  const facts = [
    ...factsFrom('a', 80, 70),
    ...factsFrom('b', 80, 70),
    ...factsFrom('c', 80, 70),
  ]
  const first = selectFactsBalancedBySource(facts, 100).map((f) => f.id)
  const shuffled = [...facts].reverse()
  const second = selectFactsBalancedBySource(shuffled, 100).map((f) => f.id)
  assert.deepEqual(first, second)
})

test('summarizeFactSelection: per-source extracted vs used accounting', () => {
  const a = factsFrom('doc-a', 3, 90)
  const b = factsFrom('doc-b', 2, 40)
  const summary = summarizeFactSelection([...a, ...b], [...a, b[0]])
  assert.deepEqual(summary, [
    { source_document_id: 'doc-a', facts_extracted: 3, facts_used: 3 },
    { source_document_id: 'doc-b', facts_extracted: 2, facts_used: 1 },
  ])
})

// ─── documentDisplayState ───────────────────────────────────────────────────
// Regression coverage for the "stuck at 14%, indistinguishable from healthy"
// observability gap: a document backing off before an automatic retry is
// stored as status='pending' with attempts > 0 — identical, at the raw
// status level, to a document that has never been attempted at all.

test('documentDisplayState: terminal statuses pass through regardless of attempts', () => {
  assert.equal(documentDisplayState('completed', 0), 'completed')
  assert.equal(documentDisplayState('completed', 2), 'completed')
  assert.equal(documentDisplayState('failed', 3), 'failed')
  assert.equal(documentDisplayState('running', 1), 'running')
})

test('documentDisplayState: pending with zero attempts is waiting, never attempted', () => {
  assert.equal(documentDisplayState('pending', 0), 'waiting')
})

test('documentDisplayState: pending with attempts > 0 is retrying, not waiting', () => {
  assert.equal(documentDisplayState('pending', 1), 'retrying')
  assert.equal(documentDisplayState('pending', 2), 'retrying')
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

// ─── classifyAnthropicError ─────────────────────────────────────────────────
//
// Evidence-driven: production logs showed the identical 6-document batch
// aborting at ~150000ms twice in a row (a retried application_timeout can
// never succeed on an unmodified payload) and a `400 Your credit balance is
// too low` not halting the run. These tests pin down the exact
// classification each of those (and every other documented category) maps
// to, and that only the three genuinely transient ones are retryable.

test('classifyAnthropicError: an abort at ~timeoutMs is application_timeout, not retryable', () => {
  const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
  assert.equal(classifyAnthropicError(err, 150002, 150_000), 'application_timeout')
  assert.equal(isRetryableClassification(classifyAnthropicError(err, 150002, 150_000)), false)
})

test('classifyAnthropicError: an abort well under timeoutMs is client_timeout, not retryable', () => {
  const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
  assert.equal(classifyAnthropicError(err, 500, 150_000), 'client_timeout')
  assert.equal(isRetryableClassification('client_timeout'), false)
})

test('classifyAnthropicError: an abort with no elapsed/timeout supplied falls back to client_timeout', () => {
  const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
  assert.equal(classifyAnthropicError(err), 'client_timeout')
})

test('classifyAnthropicError: 429 is rate_limited (retryable)', () => {
  assert.equal(classifyAnthropicError({ status: 429 }), 'rate_limited')
  assert.equal(isRetryableClassification('rate_limited'), true)
})

test('classifyAnthropicError: 529 overloaded_error and other 5xx are overloaded (retryable)', () => {
  assert.equal(classifyAnthropicError({ status: 529, error: { type: 'overloaded_error' } }), 'overloaded')
  assert.equal(classifyAnthropicError({ status: 500 }), 'overloaded')
  assert.equal(isRetryableClassification('overloaded'), true)
})

test('classifyAnthropicError: a raw fetch failure with no status is network_interruption (retryable)', () => {
  const err = Object.assign(new Error('fetch failed'), { name: 'TypeError' })
  assert.equal(classifyAnthropicError(err), 'network_interruption')
  assert.equal(isRetryableClassification('network_interruption'), true)
})

test('classifyAnthropicError: 401/403 is authentication_failed — billing-halt, never retryable', () => {
  assert.equal(classifyAnthropicError({ status: 401 }), 'authentication_failed')
  assert.equal(classifyAnthropicError({ status: 403 }), 'authentication_failed')
  assert.equal(isRetryableClassification('authentication_failed'), false)
  assert.equal(isBillingHaltClassification('authentication_failed'), true)
})

test('classifyAnthropicError: a 400 credit-balance message is credit_exhausted — billing-halt, never retryable', () => {
  const err = { status: 400, message: 'Your credit balance is too low to access the Anthropic API' }
  assert.equal(classifyAnthropicError(err), 'credit_exhausted')
  assert.equal(isRetryableClassification('credit_exhausted'), false)
  assert.equal(isBillingHaltClassification('credit_exhausted'), true)
})

test('classifyAnthropicError: a 400 context-length message is context_window_exceeded, not retryable', () => {
  const err = { status: 400, message: 'prompt is too long: 250000 tokens > 200000 maximum context length' }
  assert.equal(classifyAnthropicError(err), 'context_window_exceeded')
  assert.equal(isRetryableClassification('context_window_exceeded'), false)
  assert.equal(isBillingHaltClassification('context_window_exceeded'), false)
})

test('classifyAnthropicError: a plain 400 is invalid_request, not retryable', () => {
  assert.equal(classifyAnthropicError({ status: 400, message: 'missing required field' }), 'invalid_request')
  assert.equal(isRetryableClassification('invalid_request'), false)
})

test('classifyAnthropicError: 422 / validation_error is validation_error, not retryable', () => {
  assert.equal(classifyAnthropicError({ status: 422 }), 'validation_error')
  assert.equal(classifyAnthropicError({ error: { type: 'validation_error' } }), 'validation_error')
  assert.equal(isRetryableClassification('validation_error'), false)
})

test('classifyAnthropicError: an unrecognised error is unknown, not retryable by default', () => {
  assert.equal(classifyAnthropicError(new Error('boom')), 'unknown')
  assert.equal(classifyAnthropicError(null), 'unknown')
  assert.equal(isRetryableClassification('unknown'), false)
})

// ─── maxConsecutiveOccurrences / shouldStopRetrying / nextFailureHistory ───
//
// Production readiness review finding (blocking issue 1): the original
// shouldStopRetrying tested `!isRetryableClassification(current)` alone,
// which stopped application_timeout/context_window_exceeded on their VERY
// FIRST occurrence — making the solo-batch-retry path in index.ts
// (forcedSoloInput) unreachable for exactly the classification the
// production incident exhibited. maxConsecutiveOccurrences fixes this by
// giving those two classifications their own tier (one more attempt,
// distinct from both "never retry" and "tolerate like a transient
// failure") — these tests pin down the exact intended flow:
//   first timeout -> record failure (not yet stopped) -> retry solo ->
//   second identical timeout -> permanently fail.

test('maxConsecutiveOccurrences: billing-halt and genuinely-hopeless classifications get zero tolerance', () => {
  assert.equal(maxConsecutiveOccurrences('credit_exhausted'), 0)
  assert.equal(maxConsecutiveOccurrences('authentication_failed'), 0)
  assert.equal(maxConsecutiveOccurrences('invalid_request'), 0)
  assert.equal(maxConsecutiveOccurrences('validation_error'), 0)
  assert.equal(maxConsecutiveOccurrences('unknown'), 0)
  assert.equal(maxConsecutiveOccurrences('client_timeout'), 0)
})

test('maxConsecutiveOccurrences: application_timeout / context_window_exceeded get exactly one more attempt', () => {
  assert.equal(maxConsecutiveOccurrences('application_timeout'), 1)
  assert.equal(maxConsecutiveOccurrences('context_window_exceeded'), 1)
})

test('maxConsecutiveOccurrences: classifications that already survive one in-call retry keep their existing 2-strike tolerance', () => {
  assert.equal(maxConsecutiveOccurrences('network_interruption'), 2)
  assert.equal(maxConsecutiveOccurrences('rate_limited'), 2)
  assert.equal(maxConsecutiveOccurrences('overloaded'), 2)
})

test('shouldStopRetrying: billing-halt classifications still stop on the very first occurrence (unchanged) — regression check for existing billing-halt behaviour', () => {
  // credit_exhausted/authentication_failed never actually reach
  // shouldStopRetrying in production (haltForBilling intercepts them in
  // index.ts before recordAiFailure is ever called), but the function's
  // own contract must still treat them as zero-tolerance in case that ever
  // changes — this pins that down independently of index.ts's halt logic.
  assert.equal(maxConsecutiveOccurrences('credit_exhausted'), 0)
  assert.equal(maxConsecutiveOccurrences('authentication_failed'), 0)
  assert.equal(shouldStopRetrying(null, 0, 'credit_exhausted'), true)
  assert.equal(shouldStopRetrying(null, 0, 'authentication_failed'), true)
})

test('shouldStopRetrying: an immediately-hopeless classification stops on the very first occurrence', () => {
  assert.equal(shouldStopRetrying(null, 0, 'credit_exhausted'), true)
  assert.equal(shouldStopRetrying(null, 0, 'invalid_request'), true)
  assert.equal(shouldStopRetrying(null, 0, 'validation_error'), true)
  assert.equal(shouldStopRetrying(null, 0, 'unknown'), true)
})

test('shouldStopRetrying / integration: first application_timeout is recorded but does NOT stop — solo retry is reachable', () => {
  // Step 1: the file has never failed before.
  const first = shouldStopRetrying(null, 0, 'application_timeout')
  assert.equal(first, false, 'a first timeout must not immediately permanently fail the file — blocking issue 1')
  const afterFirst = nextFailureHistory({ classification: null, count: 0 }, 'application_timeout')
  assert.deepEqual(afterFirst, { classification: 'application_timeout', count: 1 })

  // Step 2 (in index.ts): a file at ai_failure_count === 1 is forced into
  // its own solo batch on the next invocation (forcedSoloInput) — modelled
  // here as simply calling shouldStopRetrying again with the persisted
  // state from step 1.
  const second = shouldStopRetrying(afterFirst.classification, afterFirst.count, 'application_timeout')
  assert.equal(second, true, 'a second IDENTICAL timeout (the solo retry failing the same way) must permanently fail the file')
  const afterSecond = nextFailureHistory(afterFirst, 'application_timeout')
  assert.deepEqual(afterSecond, { classification: 'application_timeout', count: 2 })
})

test('shouldStopRetrying / integration: same two-attempt flow for context_window_exceeded', () => {
  const first = shouldStopRetrying(null, 0, 'context_window_exceeded')
  assert.equal(first, false)
  const afterFirst = nextFailureHistory({ classification: null, count: 0 }, 'context_window_exceeded')
  const second = shouldStopRetrying(afterFirst.classification, afterFirst.count, 'context_window_exceeded')
  assert.equal(second, true)
})

// ─── Concurrency: no lost updates when the counter is serialized ──────────
//
// Blocking issue 3: the old recordAiFailure did a JS-side SELECT-then-
// UPDATE, which is NOT atomic across two overlapping smooth-responder
// invocations for the same job (a real possibility — reclaiming a stale
// job_intake_lock does not kill the physical old invocation still running
// server-side). The fix moves the read-compute-write into a single SQL
// function (record_ai_failure, migration 043) that holds a row lock
// (SELECT ... FOR UPDATE) for its whole transaction, so concurrent callers
// are serialized by Postgres itself rather than racing in application code.
//
// This test suite has no live Postgres instance to exercise that lock
// directly, so what's verified here is the arithmetic layer instead: fed a
// series of "concurrent" calls IN THE SERIALIZED ORDER Postgres's row lock
// guarantees (each call sees the immediately-prior call's committed
// result, never a stale read), the counter must advance by exactly one per
// call — no call's contribution is skipped or double-counted. This is
// exactly the guarantee FOR UPDATE provides mechanically; what it cannot
// prove from a pure-function test is that Postgres actually blocks a
// second transaction until the first commits — that part is architectural
// (verified by reading record_ai_failure's SQL, not testable without a
// live database).
test('concurrency: N serialized failures of the same classification produce exactly N in the counter, none lost', () => {
  let state: { classification: 'overloaded' | null; count: number } = { classification: null, count: 0 }
  const N = 5
  for (let i = 0; i < N; i++) {
    // Every "call" reads the state left by the previous one, exactly what
    // a row lock guarantees — no two calls ever read the same prior state.
    state = nextFailureHistory(state, 'overloaded')
  }
  assert.equal(state.count, N, 'every serialized call must contribute exactly one increment — a race would show as count < N')
})

test('concurrency: a stop decision made mid-sequence is consistent with the state at that exact point, not a stale read', () => {
  // Simulates two "concurrent" callers for an application_timeout file
  // (max tolerance 1): if the SQL row lock is doing its job, the SECOND
  // caller to actually commit always sees the FIRST caller's result, so
  // the stop decision is made against fresh state, not a stale snapshot
  // both callers happened to read simultaneously (the exact failure mode
  // a non-atomic SELECT-then-UPDATE was exposed to).
  let state: { classification: 'application_timeout' | null; count: number } = { classification: null, count: 0 }

  const call1Stop = shouldStopRetrying(state.classification, state.count, 'application_timeout')
  state = nextFailureHistory(state, 'application_timeout')
  assert.equal(call1Stop, false)
  assert.equal(state.count, 1)

  // A second "concurrent" caller that raced call1 but — per FOR UPDATE —
  // is forced to serialize AFTER it, sees count=1, not the stale count=0
  // a lost-update race would have produced.
  const call2Stop = shouldStopRetrying(state.classification, state.count, 'application_timeout')
  state = nextFailureHistory(state, 'application_timeout')
  assert.equal(call2Stop, true, 'the second serialized call must see the first call already recorded and stop — a race would incorrectly allow a 3rd attempt')
  assert.equal(state.count, 2)
})

test('shouldStopRetrying: a DIFFERENT classification on the second attempt resets the streak, not penalised by the prior one', () => {
  // A timeout followed by, say, a rate limit is not "the same deterministic
  // failure twice" — the streak must reset rather than compound across
  // unrelated classifications.
  const afterFirst = nextFailureHistory({ classification: null, count: 0 }, 'application_timeout')
  const second = shouldStopRetrying(afterFirst.classification, afterFirst.count, 'overloaded')
  assert.equal(second, false)
})

test('shouldStopRetrying: a retryable classification keeps its existing 2-strike tolerance (unchanged by this fix)', () => {
  assert.equal(shouldStopRetrying(null, 0, 'overloaded'), false, 'first occurrence — worth trying')
  assert.equal(shouldStopRetrying('overloaded', 1, 'overloaded'), false, 'second occurrence — still under the 2-strike threshold')
  assert.equal(shouldStopRetrying('overloaded', 2, 'overloaded'), true, 'third identical occurrence — stop')
})

test('shouldStopRetrying: a DIFFERENT classification than last time is not penalised by the prior streak', () => {
  assert.equal(shouldStopRetrying('overloaded', 2, 'rate_limited'), false)
})

test('nextFailureHistory: repeating the same classification increments the streak', () => {
  assert.deepEqual(nextFailureHistory({ classification: 'overloaded', count: 1 }, 'overloaded'), { classification: 'overloaded', count: 2 })
})

test('nextFailureHistory: a different classification resets the streak to 1', () => {
  assert.deepEqual(nextFailureHistory({ classification: 'overloaded', count: 2 }, 'rate_limited'), { classification: 'rate_limited', count: 1 })
})

test('nextFailureHistory: no prior history starts the streak at 1', () => {
  assert.deepEqual(nextFailureHistory({ classification: null, count: 0 }, 'application_timeout'), { classification: 'application_timeout', count: 1 })
})

// ─── dedupeRealFileIds ───────────────────────────────────────────────────────
//
// Blocking issue 2: a page-chunked PDF contributes several batch entries
// sharing one real files.id (`${realId}#pStart-End`) — recording a failure
// once per chunk inflated one real Claude-call failure into several
// counted occurrences, exhausting maxConsecutiveOccurrences after a single
// genuine failure for exactly the large-document profile the solo-retry
// path exists to protect.

test('dedupeRealFileIds: multiple chunks of the same file collapse to one real id', () => {
  const ids = ['file-a#p1-5', 'file-a#p6-10', 'file-a#p11-15']
  assert.deepEqual(dedupeRealFileIds(ids), ['file-a'])
})

test('dedupeRealFileIds: a mix of chunked and unchunked files dedupes only the chunked ones', () => {
  const ids = ['file-a#p1-5', 'file-a#p6-10', 'file-b', 'file-c#p1-2']
  assert.deepEqual(dedupeRealFileIds(ids), ['file-a', 'file-b', 'file-c'])
})

test('dedupeRealFileIds: a chunked-batch failure now records exactly one occurrence, not one per chunk', () => {
  // Simulates the exact scenario from the incident: one failed Claude call
  // for a batch containing 3 chunks of the same oversized document.
  const chunkIdsInFailedBatch = ['big-plan#p1-10', 'big-plan#p11-20', 'big-plan#p21-30']
  const realFileIds = dedupeRealFileIds(chunkIdsInFailedBatch)
  assert.equal(realFileIds.length, 1, 'one real document must produce exactly one recordAiFailure call, regardless of chunk count')

  // Threading that single occurrence through the same state machine used
  // above confirms it takes TWO real failed attempts (not one) to
  // permanently fail the document — the chunking bug used to reach that
  // point after a single failed batch call.
  const afterFirstFailedBatch = nextFailureHistory({ classification: null, count: 0 }, 'application_timeout')
  assert.equal(afterFirstFailedBatch.count, 1, 'one failed batch call must record exactly one occurrence')
  assert.equal(shouldStopRetrying(null, 0, 'application_timeout'), false)
})

// ─── splitBatchForRetry ──────────────────────────────────────────────────────

test('splitBatchForRetry: halves a multi-file batch', () => {
  assert.deepEqual(splitBatchForRetry([1, 2, 3, 4]), [[1, 2], [3, 4]])
  assert.deepEqual(splitBatchForRetry([1, 2, 3]), [[1, 2], [3]])
})

test('splitBatchForRetry: a single-file batch cannot be split further', () => {
  assert.equal(splitBatchForRetry([1]), null)
  assert.equal(splitBatchForRetry([]), null)
})

// ─── isRetryableApiError / withTimeoutAndRetry ─────────────────────────────

test('isRetryableApiError: an application timeout is no longer retryable — the exact bug this redesign fixes', () => {
  const abortErr = new Error('The operation was aborted')
  abortErr.name = 'AbortError'
  assert.equal(isRetryableApiError(abortErr), false, 'without elapsed/timeoutMs this classifies as client_timeout, itself also non-retryable')
})

test('isRetryableApiError: 429 and 5xx are retryable', () => {
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

test('withTimeoutAndRetry: exhausting all retries rethrows the last error, with its classification attached', async () => {
  let calls = 0
  await assert.rejects(
    withTimeoutAndRetry(async () => { calls++; throw { status: 503 } }, { maxRetries: 2 }),
    (err: unknown) => {
      assert.equal((err as { status?: number }).status, 503)
      assert.equal((err as { classification?: string }).classification, 'overloaded')
      return true
    },
  )
  assert.equal(calls, 3) // initial attempt + 2 retries
})

test('withTimeoutAndRetry: a repeated application_timeout is NOT retried — the exact production bug this fixes', async () => {
  // Both attempts would abort at ~timeoutMs given an unmodified payload —
  // this asserts the call is made exactly once, not twice, unlike the
  // pre-fix behaviour that burned two full 150s timeouts on an identical
  // oversized batch.
  let calls = 0
  const failures: Array<{ classification: string; retryable: boolean }> = []
  await assert.rejects(
    withTimeoutAndRetry(
      (signal) => new Promise((_resolve, reject) => {
        calls++
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }),
      {
        timeoutMs: 10,
        maxRetries: 2,
        onAttemptFailed: (info) => failures.push({ classification: info.classification, retryable: info.retryable }),
      },
    ),
  )
  assert.equal(calls, 1, 'an application_timeout must not trigger a second identical call')
  assert.equal(failures.length, 1)
  assert.equal(failures[0].classification, 'application_timeout')
  assert.equal(failures[0].retryable, false)
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

// ─── formatWallClockStallReason ─────────────────────────────────────────────

test('formatWallClockStallReason: includes stage name and every millisecond figure', () => {
  const reason = formatWallClockStallReason('generating_estimate', 150_000, 200_000, 340_000)
  assert.match(reason, /generating_estimate/)
  assert.match(reason, /150000ms/)
  assert.match(reason, /200000ms/)
  assert.match(reason, /340000ms/)
  assert.match(reason, /not a content or model failure/)
})

// ─── Stage 3: evidence truncation ───────────────────────────────────────────

test('truncateEvidence: leaves short evidence untouched', () => {
  assert.equal(truncateEvidence('a short note', 240), 'a short note')
})

test('truncateEvidence: null evidence stays null', () => {
  assert.equal(truncateEvidence(null, 240), null)
})

test('truncateEvidence: caps at exactly maxChars plus an ellipsis marker', () => {
  const long = 'x'.repeat(1000)
  const result = truncateEvidence(long, 240)
  assert.equal(result!.length, 241) // 240 chars + the ellipsis character
  assert.ok(result!.endsWith('…'))
  assert.equal(result!.slice(0, 240), 'x'.repeat(240))
})

test('truncateEvidence: an evidence string of ARBITRARY length is bounded to a fixed cap', () => {
  for (const len of [241, 5_000, 50_000, 1_000_000]) {
    const evidence = 'y'.repeat(len)
    const result = truncateEvidence(evidence, STAGE3_MAX_EVIDENCE_CHARS)
    assert.ok(result!.length <= STAGE3_MAX_EVIDENCE_CHARS + 1, `length ${len} produced an unbounded result`)
  }
})

function makeFact(overrides: Partial<FactRow> = {}): FactRow {
  return {
    category: 'structural', key: 'slab_type', value: 'waffle pod',
    evidence: 'per drawing S1.01 note 4', confidence: 80,
    ...overrides,
  }
}

test('formatFactForScopePrompt: preserves category/key/value/confidence exactly', () => {
  const line = formatFactForScopePrompt(makeFact(), 240)
  assert.match(line, /^- \[structural\] slab_type: waffle pod \(confidence 80%/)
})

test('formatFactForScopePrompt: caps only the evidence portion of the line', () => {
  const line = formatFactForScopePrompt(makeFact({ evidence: 'z'.repeat(10_000) }), 240)
  // category/key/value/confidence prefix is short and untouched regardless
  // of evidence length — only the evidence segment grows unbounded input
  assert.ok(line.length < 10_000, 'the whole line must not scale with evidence length')
  assert.match(line, /^- \[structural\] slab_type: waffle pod \(confidence 80%, evidence: z+…\)$/)
})

test('formatFactForScopePrompt: a fact with no evidence omits the evidence segment entirely', () => {
  const line = formatFactForScopePrompt(makeFact({ evidence: null }), 240)
  assert.equal(line, '- [structural] slab_type: waffle pod (confidence 80%)')
})

test('formatFactForScopePrompt: total prompt size for N facts with unbounded evidence stays bounded by N * cap, not by the raw evidence size', () => {
  const facts: FactRow[] = Array.from({ length: MAX_FACTS_IN_PROMPT }, (_, i) =>
    makeFact({ key: `fact_${i}`, evidence: 'w'.repeat(20_000) }) // 20,000 chars of evidence each
  )
  const block = facts.map((f) => formatFactForScopePrompt(f)).join('\n')
  // Without capping this would be ~200 * 20,000 = 4,000,000 chars. With
  // capping it must stay in the low tens of thousands regardless.
  assert.ok(block.length < MAX_FACTS_IN_PROMPT * (STAGE3_MAX_EVIDENCE_CHARS + 120),
    `prompt block was ${block.length} chars — evidence truncation did not bound it`)
})

// ─── Stage 3: trade chunking ─────────────────────────────────────────────────

test('shouldChunkTradeReasoning: false at or under the threshold', () => {
  assert.equal(shouldChunkTradeReasoning(STAGE3_TRADE_CHUNK_FACT_THRESHOLD), false)
  assert.equal(shouldChunkTradeReasoning(10), false)
})

test('shouldChunkTradeReasoning: true once strictly over the threshold', () => {
  assert.equal(shouldChunkTradeReasoning(STAGE3_TRADE_CHUNK_FACT_THRESHOLD + 1), true)
  assert.equal(shouldChunkTradeReasoning(200), true)
})

test('desiredStage3ChunkCount: at or under the chunk threshold -> 1 (no chunking)', () => {
  assert.equal(desiredStage3ChunkCount(STAGE3_TRADE_CHUNK_FACT_THRESHOLD), 1)
  assert.equal(desiredStage3ChunkCount(10), 1)
})

test('desiredStage3ChunkCount: over the chunk threshold but at or under the large-project threshold -> the default 2', () => {
  assert.equal(desiredStage3ChunkCount(STAGE3_TRADE_CHUNK_FACT_THRESHOLD + 1), 2)
  assert.equal(desiredStage3ChunkCount(STAGE3_LARGE_PROJECT_FACT_THRESHOLD), 2)
})

test('desiredStage3ChunkCount: strictly over the large-project threshold -> the wider large-project count', () => {
  assert.equal(desiredStage3ChunkCount(STAGE3_LARGE_PROJECT_FACT_THRESHOLD + 1), STAGE3_LARGE_PROJECT_CHUNK_COUNT)
  assert.equal(desiredStage3ChunkCount(200), STAGE3_LARGE_PROJECT_CHUNK_COUNT)
})

test('desiredStage3ChunkCount: at the real MAX_FACTS_IN_PROMPT cap (200) uses 3 chunks, not 2 — the exact scenario a real project hit', () => {
  assert.equal(desiredStage3ChunkCount(200), 3)
})

test('splitTradeCategoriesIntoChunks: splits 13 trades into 2 near-equal, contiguous, order-preserving groups', () => {
  const trades = Array.from({ length: 13 }, (_, i) => ({ id: i + 1 }))
  const chunks = splitTradeCategoriesIntoChunks(trades, 2)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].length + chunks[1].length, 13)
  // every trade appears exactly once, across both chunks combined
  const allIds = chunks.flat().map((t) => t.id)
  assert.deepEqual(allIds, trades.map((t) => t.id))
  assert.equal(new Set(allIds).size, 13)
})

test('splitTradeCategoriesIntoChunks: chunkCount of 1 is the identity split', () => {
  const trades = [{ id: 1 }, { id: 2 }, { id: 3 }]
  assert.deepEqual(splitTradeCategoriesIntoChunks(trades, 1), [trades])
})

test('splitTradeCategoriesIntoChunks: chunkCount larger than the list never produces an empty group', () => {
  const trades = [{ id: 1 }, { id: 2 }]
  const chunks = splitTradeCategoriesIntoChunks(trades, 5)
  assert.ok(chunks.every((c) => c.length > 0))
  assert.equal(chunks.flat().length, 2)
})

test('splitTradeCategoriesIntoChunks: deterministic — same input always produces the same split', () => {
  const trades = Array.from({ length: 13 }, (_, i) => ({ id: i + 1 }))
  const a = splitTradeCategoriesIntoChunks(trades, 2)
  const b = splitTradeCategoriesIntoChunks(trades, 2)
  assert.deepEqual(a, b)
})

// ─── planStage3Chunks: budget-aware chunk planning ─────────────────────────

const TRADES_13 = Array.from({ length: 13 }, (_, i) => ({ id: i + 1 }))

test('planStage3Chunks: no remaining trades -> nothing to do, no more after', () => {
  const plan = planStage3Chunks([], 340_000, 150)
  assert.deepEqual(plan, { chunksToRunNow: [], hasMoreAfterThisInvocation: false })
})

test('planStage3Chunks: plenty of budget, below chunk threshold -> single chunk with all trades, no deferral', () => {
  const plan = planStage3Chunks(TRADES_13, 340_000, 50) // 50 facts, under STAGE3_TRADE_CHUNK_FACT_THRESHOLD
  assert.equal(plan.chunksToRunNow.length, 1)
  assert.equal(plan.chunksToRunNow[0].length, 13)
  assert.equal(plan.hasMoreAfterThisInvocation, false)
})

test('planStage3Chunks: 200 facts (the real MAX_FACTS_IN_PROMPT cap) plans 3 chunks, not 2 -- fewer trades/call for the case with the least wall-clock margin', () => {
  const plan = planStage3Chunks(TRADES_13, 1_000_000, 200)
  assert.equal(plan.chunksToRunNow.length, 3)
  assert.equal(plan.chunksToRunNow.reduce((sum, c) => sum + c.length, 0), 13)
})

test('planStage3Chunks: plenty of budget, above chunk threshold -> the full desired chunk plan runs now', () => {
  // NOTE: 1,000,000ms here is deliberately larger than this codebase's real
  // WALL_CLOCK_SAFETY_MS (340,000ms) -- this is a pure-function unit test of
  // chunk-count logic in isolation, not a claim that 340,000ms is "plenty."
  // In fact 340,000 < 2 x STAGE3_PER_CALL_TIMEOUT_MS (440,000), a genuine
  // structural finding: even a hypothetical zero-elapsed invocation cannot
  // fit 2 full desired chunks inside the real ceiling -- see the two tests
  // below, which use the REAL constants and correctly expect deferral.
  const plan = planStage3Chunks(TRADES_13, 1_000_000, 150) // over threshold
  assert.equal(plan.chunksToRunNow.length, STAGE3_DEFAULT_CHUNK_COUNT)
  assert.equal(plan.chunksToRunNow.flat().length, 13)
  assert.equal(plan.hasMoreAfterThisInvocation, false)
})

test('planStage3Chunks: REAL WALL_CLOCK_SAFETY_MS (340s) cannot fit 2 full 220s chunks -> always defers on a chunked project, by design', () => {
  // This is the structural fact the production incident traced back to:
  // 340,000 < 2 x 220,000. A chunked project (>100 facts) can NEVER
  // complete Stage 3 in a single invocation no matter how little of the
  // budget Stage 1/2 consumed -- persistence across invocations (this
  // migration) is not an optimization here, it's the only way a large
  // project can ever finish at all.
  const plan = planStage3Chunks(TRADES_13, 340_000, 150)
  assert.equal(plan.chunksToRunNow.length, 1, 'only one of the two desired chunks fits even in the full real budget')
  assert.equal(plan.hasMoreAfterThisInvocation, true)
})

test('planStage3Chunks: budget fits only ONE of the two desired chunks -> runs one now, defers the rest, never inflates the chunk', () => {
  // Only room for exactly 1 call (just over STAGE3_PER_CALL_TIMEOUT_MS,
  // under 2x it) -- must NOT cram all 13 trades into that one call.
  const plan = planStage3Chunks(TRADES_13, STAGE3_PER_CALL_TIMEOUT_MS + 5_000, 150)
  assert.equal(plan.chunksToRunNow.length, 1)
  assert.ok(plan.chunksToRunNow[0].length < 13, 'the one chunk that runs must still be the right-sized half, not all 13 trades')
  assert.equal(plan.hasMoreAfterThisInvocation, true)
})

test('planStage3Chunks: zero room for even one call -> nothing attempted, everything deferred, no wasted spend', () => {
  const plan = planStage3Chunks(TRADES_13, STAGE3_PER_CALL_TIMEOUT_MS - 1, 150)
  assert.deepEqual(plan.chunksToRunNow, [])
  assert.equal(plan.hasMoreAfterThisInvocation, true)
})

test('planStage3Chunks: resuming with only some trades remaining (prior invocation already completed the rest) — below chunk threshold, fits in one call', () => {
  const remaining = TRADES_13.slice(7) // trades 8-13, as if 1-7 already completed and persisted
  const plan = planStage3Chunks(remaining, 340_000, 50) // under STAGE3_TRADE_CHUNK_FACT_THRESHOLD -> desiredGroups=1
  assert.equal(plan.chunksToRunNow.flat().length, 6)
  assert.equal(plan.hasMoreAfterThisInvocation, false)
})

test('planStage3Chunks: resuming with only 6 of 13 trades remaining, still above chunk threshold -> still splits into the desired 2 groups of the REMAINING trades only', () => {
  const remaining = TRADES_13.slice(7) // trades 8-13
  const plan = planStage3Chunks(remaining, 1_000_000, 150) // over threshold, ample budget
  assert.equal(plan.chunksToRunNow.length, STAGE3_DEFAULT_CHUNK_COUNT)
  assert.equal(plan.chunksToRunNow.flat().length, 6, 'only the 6 remaining trades are planned -- never the original 13')
  assert.equal(plan.hasMoreAfterThisInvocation, false)
})

test('planStage3Chunks: never plans a call needing more than STAGE3_PER_CALL_TIMEOUT_MS regardless of how much budget is available', () => {
  // Even with a huge budget, chunk SIZE is governed by the desired chunk
  // count (complexity-based), not by how much room happens to exist --
  // more budget must never cause fewer, bigger chunks.
  const plan = planStage3Chunks(TRADES_13, 10_000_000, 150)
  assert.equal(plan.chunksToRunNow.length, STAGE3_DEFAULT_CHUNK_COUNT)
})

test('mergeScopeReasoningResults: concatenates disjoint per-trade scope from each chunk', () => {
  const chunkA = { scope: [{ trade_category_id: 1, included_scope: ['footings'] }], clarifying_questions: [] }
  const chunkB = { scope: [{ trade_category_id: 12, included_scope: ['power points'] }], clarifying_questions: [] }
  const merged = mergeScopeReasoningResults([chunkA, chunkB])
  assert.equal(merged.scope.length, 2)
  assert.deepEqual(new Set(merged.scope.map((s) => s.trade_category_id)), new Set([1, 12]))
})

test('mergeScopeReasoningResults: a defensive trade_category_id collision merges both sides (never a silent overwrite) and is reported in tradeCollisions', () => {
  const chunkA = { scope: [{ trade_category_id: 1, included_scope: ['siteworks item A'] }], clarifying_questions: [] }
  const chunkB = { scope: [{ trade_category_id: 1, included_scope: ['siteworks item B'] }], clarifying_questions: [] }
  const merged = mergeScopeReasoningResults([chunkA, chunkB])
  assert.equal(merged.scope.length, 1, 'still exactly one entry per trade — merged, not duplicated')
  assert.deepEqual(merged.scope[0].included_scope, ['siteworks item A', 'siteworks item B'], 'both sides survive, deduplicated union')
  assert.deepEqual(merged.tradeCollisions, [1])
})

test('mergeScopeReasoningResults: no collision -> tradeCollisions is empty', () => {
  const chunkA = { scope: [{ trade_category_id: 1, included_scope: ['a'] }], clarifying_questions: [] }
  const chunkB = { scope: [{ trade_category_id: 2, included_scope: ['b'] }], clarifying_questions: [] }
  const merged = mergeScopeReasoningResults([chunkA, chunkB])
  assert.deepEqual(merged.tradeCollisions, [])
})

test('mergeScopeReasoningResults: preserves clarifying_questions, deduplicating exact (question, trade) repeats across chunks', () => {
  const chunkA = {
    scope: [], clarifying_questions: [
      { question: 'Any structural drawings?', reason: 'needed for framing', trade_category_id: 2, blocking: true },
    ],
  }
  const chunkB = {
    scope: [], clarifying_questions: [
      { question: 'Any structural drawings?', reason: 'needed for framing', trade_category_id: 2, blocking: true },
      { question: 'What tapware finish?', reason: 'affects cost', trade_category_id: 11, blocking: false },
    ],
  }
  const merged = mergeScopeReasoningResults([chunkA, chunkB])
  assert.equal(merged.clarifying_questions.length, 2)
  assert.ok(merged.clarifying_questions.some((q) => q.question === 'Any structural drawings?'))
  assert.ok(merged.clarifying_questions.some((q) => q.question === 'What tapware finish?'))
})

test('mergeScopeReasoningResults: preserves assumptions/dependencies/uncertainty_notes untouched per trade', () => {
  const chunk = {
    scope: [{
      trade_category_id: 3, included_scope: ['roof sheeting'], excluded_scope: ['gutters'],
      dependencies: ['framing complete'], assumptions: ['colorbond'], uncertainty_notes: 'pitch unclear', confidence: 70,
    }],
    clarifying_questions: [],
  }
  const merged = mergeScopeReasoningResults([chunk])
  assert.deepEqual(merged.scope[0], chunk.scope[0])
})

test('mergeScopeReasoningResults: a single chunk (no chunking) round-trips unchanged — existing single-call behaviour preserved', () => {
  const single = {
    scope: [{ trade_category_id: 1, included_scope: ['a'] }, { trade_category_id: 2, included_scope: ['b'] }],
    clarifying_questions: [{ question: 'q1', reason: 'r1', trade_category_id: null, blocking: false }],
  }
  const merged = mergeScopeReasoningResults([single])
  assert.equal(merged.scope.length, 2)
  assert.equal(merged.clarifying_questions.length, 1)
})

// ─── Stage 3: failure-escalation identity (batch + input hash, not files.id) ─

const HASH_A = 'aaaa1111'
const HASH_B = 'bbbb2222'
const NO_HISTORY: Stage3FailureHistory = { inputHash: null, classification: null, count: 0 }

test('shouldSkipStage3Call: never skips when there is no prior history', () => {
  assert.equal(shouldSkipStage3Call(NO_HISTORY, HASH_A), false)
})

test('shouldSkipStage3Call: never skips a genuinely different input, regardless of prior count', () => {
  const prior: Stage3FailureHistory = { inputHash: HASH_A, classification: 'application_timeout', count: 5 }
  assert.equal(shouldSkipStage3Call(prior, HASH_B), false)
})

test('shouldSkipStage3Call: does NOT skip after exactly one recorded failure — "one more attempt" must still fire', () => {
  // application_timeout tolerates exactly 1 occurrence before stopping —
  // after the FIRST failure is recorded (count=1), the retry it earns must
  // still be allowed to run.
  const max = maxConsecutiveOccurrences('application_timeout')
  const prior: Stage3FailureHistory = { inputHash: HASH_A, classification: 'application_timeout', count: max }
  assert.equal(shouldSkipStage3Call(prior, HASH_A), false)
})

test('shouldSkipStage3Call: skips once a SECOND identical failure has been recorded for the same input', () => {
  const max = maxConsecutiveOccurrences('application_timeout')
  const prior: Stage3FailureHistory = { inputHash: HASH_A, classification: 'application_timeout', count: max + 1 }
  assert.equal(shouldSkipStage3Call(prior, HASH_A), true)
})

test('shouldSkipStage3Call: does NOT skip an identical input that has not yet exhausted its allowance', () => {
  const prior: Stage3FailureHistory = { inputHash: HASH_A, classification: 'application_timeout', count: 0 }
  assert.equal(shouldSkipStage3Call(prior, HASH_A), false)
})

test('nextStage3FailureHistory: identical input + identical classification increments the streak', () => {
  const prior: Stage3FailureHistory = { inputHash: HASH_A, classification: 'application_timeout', count: 1 }
  const next = nextStage3FailureHistory(prior, { inputHash: HASH_A, classification: 'application_timeout' })
  assert.deepEqual(next, { inputHash: HASH_A, classification: 'application_timeout', count: 2 })
})

test('nextStage3FailureHistory: a genuinely different input resets the streak to 1, even with the same classification', () => {
  const prior: Stage3FailureHistory = { inputHash: HASH_A, classification: 'application_timeout', count: 3 }
  const next = nextStage3FailureHistory(prior, { inputHash: HASH_B, classification: 'application_timeout' })
  assert.deepEqual(next, { inputHash: HASH_B, classification: 'application_timeout', count: 1 })
})

test('nextStage3FailureHistory: identical input but a different classification resets the streak to 1', () => {
  const prior: Stage3FailureHistory = { inputHash: HASH_A, classification: 'application_timeout', count: 2 }
  const next = nextStage3FailureHistory(prior, { inputHash: HASH_A, classification: 'rate_limited' })
  assert.deepEqual(next, { inputHash: HASH_A, classification: 'rate_limited', count: 1 })
})

test('nextStage3FailureHistory: end-to-end — identical input escalates to skip, changed input gets a fresh allowance', () => {
  let history: Stage3FailureHistory = NO_HISTORY
  // First failure on input A
  history = nextStage3FailureHistory(history, { inputHash: HASH_A, classification: 'application_timeout' })
  assert.equal(shouldSkipStage3Call(history, HASH_A), false, 'first failure alone must not skip the next attempt')
  // Second identical failure on the SAME input — now exhausted
  history = nextStage3FailureHistory(history, { inputHash: HASH_A, classification: 'application_timeout' })
  assert.equal(shouldSkipStage3Call(history, HASH_A), true, 'a repeat of the identical input must now be skipped')
  // A genuinely new upload changes the merged fact base -> different hash -> fresh allowance
  assert.equal(shouldSkipStage3Call(history, HASH_B), false, 'a changed document set must not inherit the exhausted history')
})

// ─── Stage 6: failure-escalation identity (mirrors Stage 3's exactly, migration 077) ─

const NO_HISTORY_STAGE6: Stage6FailureHistory = { inputHash: null, classification: null, count: 0 }

test('shouldSkipStage6Call: never skips when there is no prior history', () => {
  assert.equal(shouldSkipStage6Call(NO_HISTORY_STAGE6, HASH_A), false)
})

test('shouldSkipStage6Call: never skips a genuinely different input, regardless of prior count', () => {
  const prior: Stage6FailureHistory = { inputHash: HASH_A, classification: 'application_timeout', count: 5 }
  assert.equal(shouldSkipStage6Call(prior, HASH_B), false)
})

test('shouldSkipStage6Call: does NOT skip after exactly one recorded failure — "one more attempt" must still fire', () => {
  const max = maxConsecutiveOccurrences('application_timeout')
  const prior: Stage6FailureHistory = { inputHash: HASH_A, classification: 'application_timeout', count: max }
  assert.equal(shouldSkipStage6Call(prior, HASH_A), false)
})

test('shouldSkipStage6Call: skips once a SECOND identical failure has been recorded for the same input', () => {
  const max = maxConsecutiveOccurrences('application_timeout')
  const prior: Stage6FailureHistory = { inputHash: HASH_A, classification: 'application_timeout', count: max + 1 }
  assert.equal(shouldSkipStage6Call(prior, HASH_A), true)
})

test('nextStage6FailureHistory: identical input + identical classification increments the streak', () => {
  const prior: Stage6FailureHistory = { inputHash: HASH_A, classification: 'application_timeout', count: 1 }
  const next = nextStage6FailureHistory(prior, { inputHash: HASH_A, classification: 'application_timeout' })
  assert.deepEqual(next, { inputHash: HASH_A, classification: 'application_timeout', count: 2 })
})

test('nextStage6FailureHistory: a genuinely different input resets the streak to 1, even with the same classification', () => {
  const prior: Stage6FailureHistory = { inputHash: HASH_A, classification: 'application_timeout', count: 3 }
  const next = nextStage6FailureHistory(prior, { inputHash: HASH_B, classification: 'application_timeout' })
  assert.deepEqual(next, { inputHash: HASH_B, classification: 'application_timeout', count: 1 })
})

test('nextStage6FailureHistory: end-to-end — identical input escalates to skip, changed input gets a fresh allowance', () => {
  let history: Stage6FailureHistory = NO_HISTORY_STAGE6
  history = nextStage6FailureHistory(history, { inputHash: HASH_A, classification: 'application_timeout' })
  assert.equal(shouldSkipStage6Call(history, HASH_A), false, 'first failure alone must not skip the next attempt')
  history = nextStage6FailureHistory(history, { inputHash: HASH_A, classification: 'application_timeout' })
  assert.equal(shouldSkipStage6Call(history, HASH_A), true, 'a repeat of the identical input must now be skipped')
  assert.equal(shouldSkipStage6Call(history, HASH_B), false, 'a changed input must not inherit the exhausted history')
})

// ─── Audit: chunk merge behaviour against 4 specific scenarios ─────────────
// (dedup questions / preserve conflicts / preserve dependencies / never
// silently drop uncertainty) — see the investigation this responds to.

// Scenario 1: two chunks independently raise the textually IDENTICAL
// clarifying question (plausible for a general, non-trade-specific gap like
// "no structural drawings" that both chunks' reasoning notices).
test('AUDIT scenario 1: two chunks raising the exact same question text (general, trade_category_id null) are deduplicated', () => {
  const chunkA: ScopeReasoningResult = {
    scope: [], clarifying_questions: [
      { question: 'No structural drawings provided.', reason: 'affects framing and footings', trade_category_id: null, blocking: true },
    ],
  }
  const chunkB: ScopeReasoningResult = {
    scope: [], clarifying_questions: [
      { question: 'No structural drawings provided.', reason: 'affects electrical conduit routing', trade_category_id: null, blocking: true },
    ],
  }
  const merged = mergeScopeReasoningResults([chunkA, chunkB])
  // Same finding: dedup is keyed on (question text, trade_category_id) only
  // — a DIFFERENT `reason` string on an otherwise-identical question does
  // NOT prevent dedup, so only chunk A's reason survives. This is a real,
  // observable behaviour worth knowing (the second chunk's specific "why"
  // is silently dropped when the question text matches exactly) — flagged
  // below as scenario 1's finding, not fixed here since the question ITSELF
  // (the builder-facing content) is correctly deduplicated, which is what
  // "deduplicates questions" asks for.
  assert.equal(merged.clarifying_questions.length, 1)
  assert.equal(merged.clarifying_questions[0].reason, 'affects framing and footings')
})

// Scenario 1b: the same underlying gap, phrased differently by each chunk
// (realistic — chunk A and chunk B are independent Claude calls with no
// shared context, so identical wording is not guaranteed even for the same
// real-world gap).
test('AUDIT scenario 1b: near-duplicate questions (different wording, same real gap) are NOT deduplicated — both survive', () => {
  const chunkA: ScopeReasoningResult = {
    scope: [], clarifying_questions: [
      { question: 'Are structural engineering drawings available?', reason: 'needed for footing sizes', trade_category_id: null, blocking: true },
    ],
  }
  const chunkB: ScopeReasoningResult = {
    scope: [], clarifying_questions: [
      { question: 'Do we have the structural drawing set?', reason: 'needed for slab design', trade_category_id: null, blocking: true },
    ],
  }
  const merged = mergeScopeReasoningResults([chunkA, chunkB])
  // FINDING (not a bug in mergeScopeReasoningResults itself, a documented
  // limitation): dedup is exact-text only, by design (see scenario 4 for
  // why fuzzy matching would be the wrong fix). Two independently-worded
  // questions about the same real document gap both survive as separate
  // entries. "Does not silently drop uncertainty" is satisfied (neither is
  // lost) but "deduplicates questions" is only satisfied for LITERAL
  // repeats, not semantic ones.
  assert.equal(merged.clarifying_questions.length, 2)
})

// Scenario 2: two chunks return CONFLICTING scope for the SAME
// trade_category_id — should only happen if a chunk doesn't fully respect
// its assigned trade subset (each chunk is instructed to reason only about
// its own trades), but nothing in mergeScopeReasoningResults enforces that
// boundary, so it's worth proving what happens if it does.
test('AUDIT scenario 2 (FIXED): conflicting assumptions for the SAME trade across two chunks are both preserved, flagged, and lower confidence', () => {
  const chunkA: ScopeReasoningResult = {
    scope: [{
      trade_category_id: 2, included_scope: ['timber frame construction'], excluded_scope: [],
      dependencies: [], assumptions: ['assume standard timber frame, no engineering required'],
      uncertainty_notes: null, confidence: 70,
    }],
    clarifying_questions: [],
  }
  const chunkB: ScopeReasoningResult = {
    scope: [{
      trade_category_id: 2, included_scope: ['steel portal frame construction'], excluded_scope: [],
      dependencies: [], assumptions: ['assume engineered steel frame per structural drawings'],
      uncertainty_notes: null, confidence: 60,
    }],
    clarifying_questions: [],
  }
  const merged = mergeScopeReasoningResults([chunkA, chunkB])
  // Fixed behaviour: both sides survive (union, not overwrite), the
  // collision is reported in tradeCollisions for the caller to log, and an
  // explicit uncertainty_notes marker flags the disagreement instead of
  // resolving it silently one way.
  assert.equal(merged.scope.length, 1, 'still one entry per trade — merged, not duplicated')
  assert.deepEqual(merged.tradeCollisions, [2])
  const survivingIncluded = merged.scope[0].included_scope as string[]
  assert.ok(survivingIncluded.includes('timber frame construction'), 'chunk A is preserved')
  assert.ok(survivingIncluded.includes('steel portal frame construction'), 'chunk B is preserved')
  const survivingAssumptions = merged.scope[0].assumptions as string[]
  assert.ok(survivingAssumptions.some((a) => a.includes('timber')), 'chunk A assumption text survives')
  assert.ok(survivingAssumptions.some((a) => a.includes('steel')), 'chunk B assumption text survives')
  assert.match(merged.scope[0].uncertainty_notes as string, /merge conflict/i)
  assert.equal(merged.scope[0].confidence, 60, 'confidence takes the more conservative (lower) of the two')
})

// Scenario 3: a dependency discovered while reasoning about one trade that
// affects a DIFFERENT trade in another chunk.
test('AUDIT scenario 3: a cross-trade dependency noted by the chunk that owns the source trade is preserved verbatim', () => {
  // Chunk A owns trade 2 (Framing) and notes a dependency on trade 12
  // (Electrical, owned by chunk B) as plain text within its OWN entry —
  // this is the only way a single chunk call can express a cross-trade
  // dependency, since it has no visibility into the other chunk's output.
  const chunkA: ScopeReasoningResult = {
    scope: [{
      trade_category_id: 2, included_scope: ['wall framing'], excluded_scope: [],
      dependencies: ['electrical conduit chasing (trade 12) must be coordinated before wall linings close up framing'],
      assumptions: [], uncertainty_notes: null, confidence: 75,
    }],
    clarifying_questions: [],
  }
  const chunkB: ScopeReasoningResult = {
    scope: [{
      trade_category_id: 12, included_scope: ['power points', 'switchboard'], excluded_scope: [],
      dependencies: [], assumptions: [], uncertainty_notes: null, confidence: 80,
    }],
    clarifying_questions: [],
  }
  const merged = mergeScopeReasoningResults([chunkA, chunkB])
  const framingEntry = merged.scope.find((s) => s.trade_category_id === 2)
  const electricalEntry = merged.scope.find((s) => s.trade_category_id === 12)
  // What the merge function itself guarantees: whatever a chunk actually
  // returned is preserved verbatim — proven here.
  assert.deepEqual(framingEntry!.dependencies, chunkA.scope[0].dependencies)
  // FINDING (a structural limitation of chunking, not a merge-function bug):
  // the dependency is only recorded on trade 2's (Framing's) side, because
  // chunk B — reasoning about trade 12 independently, with no visibility
  // into chunk A's output — never had the opportunity to also note it on
  // trade 12's side the way a single, unchunked call reasoning about both
  // trades together could have. mergeScopeReasoningResults cannot invent a
  // cross-reference neither chunk actually returned; this is inherent to
  // running the two chunks as independent calls, not a defect in the merge
  // step itself.
  assert.deepEqual(electricalEntry!.dependencies, [], 'the same dependency is NOT mirrored onto the affected trade — chunking cannot coordinate this without shared context')
})

// Scenario 4: multiple trade chunks each identify a missing document as a
// gap, from their own trade's perspective.
test('AUDIT scenario 4: a missing document identified independently by multiple trade chunks — every distinct concern survives, none silently dropped', () => {
  const chunkA: ScopeReasoningResult = { // trades 1-6 group
    scope: [], clarifying_questions: [
      { question: 'No architectural drawings provided for the roof plan.', reason: 'roofing quantities cannot be measured', trade_category_id: 3, blocking: true },
    ],
  }
  const chunkB: ScopeReasoningResult = { // trades 7-13 group
    scope: [], clarifying_questions: [
      { question: 'No architectural drawings provided for the roof plan.', reason: 'gutter/downpipe layout cannot be determined', trade_category_id: 3, blocking: true },
      { question: 'Fixture schedule not supplied.', reason: 'tapware selections cannot be priced', trade_category_id: 11, blocking: false },
    ],
  }
  const merged = mergeScopeReasoningResults([chunkA, chunkB])
  // The (question, trade_category_id) pair is IDENTICAL between chunk A and
  // chunk B's first question (same text, same trade_category_id=3) — this
  // is the one case scenario 4 collapses to an exact duplicate, so it
  // dedupes correctly (chunk A's reason wins, same finding as scenario 1).
  // The distinctly-different fixture-schedule question is unrelated and
  // must survive untouched.
  assert.equal(merged.clarifying_questions.length, 2)
  assert.ok(merged.clarifying_questions.some((q) => q.question === 'No architectural drawings provided for the roof plan.' && q.reason === 'roofing quantities cannot be measured'))
  assert.ok(merged.clarifying_questions.some((q) => q.question === 'Fixture schedule not supplied.'))
})

// ─── Deterministic duplicate detection (Phase 1) ────────────────────────────

test('sha256Hex: same bytes produce the same hash', async () => {
  const bytes = new Uint8Array([37, 12, 255, 0, 8, 200])
  const h1 = await sha256Hex(bytes)
  const h2 = await sha256Hex(new Uint8Array([37, 12, 255, 0, 8, 200]))
  assert.equal(h1, h2)
  assert.equal(h1.length, 64) // hex-encoded SHA-256
})

test('sha256Hex: different bytes produce different hashes', async () => {
  const h1 = await sha256Hex(new Uint8Array([1, 2, 3]))
  const h2 = await sha256Hex(new Uint8Array([1, 2, 4]))
  assert.notEqual(h1, h2)
})

test('decideDuplicateFile: Test 1 — identical PDF uploaded twice in separate sessions is detected as a duplicate of the original', () => {
  const candidates: HashedFileCandidate[] = [
    { id: 'file-original', job_id: 'job-1', content_hash: 'abc123', created_at: '2026-07-01T09:00:00Z' },
  ]
  // Second upload, a later session, same job — its own hash matches the
  // already-persisted original.
  const result = decideDuplicateFile('abc123', candidates, 'file-second-upload', 'job-1')
  assert.equal(result.isDuplicate, true)
  assert.equal(result.originalFileId, 'file-original')
})

test('decideDuplicateFile: Test 2 — same filename, different content is NOT a duplicate', () => {
  // Filename is not even a parameter of this function — matching is
  // content-only. Two files named identically but with different bytes
  // hash differently and must not collide.
  const candidates: HashedFileCandidate[] = [
    { id: 'file-v1', job_id: 'job-1', content_hash: 'hash-of-v1-content', created_at: '2026-07-01T09:00:00Z' },
  ]
  const result = decideDuplicateFile('hash-of-v2-content', candidates, 'file-v2', 'job-1')
  assert.equal(result.isDuplicate, false)
  assert.equal(result.originalFileId, null)
})

test('decideDuplicateFile: Test 3 — different filename, identical content IS detected as a duplicate', () => {
  // The candidate list carries no filename at all — only id/job_id/hash/
  // created_at — so this is structurally identical to Test 1 from the
  // function's point of view, proving filename plays no role in the
  // decision either way.
  const candidates: HashedFileCandidate[] = [
    { id: 'plans-v1.pdf-id', job_id: 'job-1', content_hash: 'same-bytes-hash', created_at: '2026-07-01T09:00:00Z' },
  ]
  const result = decideDuplicateFile('same-bytes-hash', candidates, 'renamed-copy.pdf-id', 'job-1')
  assert.equal(result.isDuplicate, true)
  assert.equal(result.originalFileId, 'plans-v1.pdf-id')
})

test('decideDuplicateFile: Test 4 — a failed hash computation (represented as null) never blocks the upload — always resolves to not-a-duplicate', () => {
  const candidates: HashedFileCandidate[] = [
    { id: 'file-original', job_id: 'job-1', content_hash: 'abc123', created_at: '2026-07-01T09:00:00Z' },
  ]
  // Even though a candidate with a matching-looking hash exists, a null
  // input hash (hash computation failed) must never be treated as a match
  // — the fail-safe path always falls through to normal, non-duplicate
  // processing.
  const result = decideDuplicateFile(null, candidates, 'file-second-upload', 'job-1')
  assert.equal(result.isDuplicate, false)
  assert.equal(result.originalFileId, null)
})

test('decideDuplicateFile: Test D — identical bytes uploaded to two DIFFERENT jobs are NOT treated as duplicates of each other', () => {
  // Confirms WorkA's product rule directly rather than assuming it: each
  // job is an independent client project, so a byte-identical file
  // legitimately shared across two unrelated jobs (a boilerplate spec
  // cover page, a reused template) must not cause job-2's upload to be
  // silently skipped/attributed to job-1's file. job_id is checked inside
  // this pure function itself (not left solely to the caller's SQL query
  // filter) specifically so this guarantee survives even if a future
  // caller's query ever dropped its own job_id filter.
  const candidates: HashedFileCandidate[] = [
    { id: 'job1-file', job_id: 'job-1', content_hash: 'shared-boilerplate-hash', created_at: '2026-07-01T09:00:00Z' },
  ]
  const result = decideDuplicateFile('shared-boilerplate-hash', candidates, 'job2-file', 'job-2')
  assert.equal(result.isDuplicate, false)
  assert.equal(result.originalFileId, null)
})

test('decideDuplicateFile: a file never matches itself', () => {
  const candidates: HashedFileCandidate[] = [
    { id: 'file-a', job_id: 'job-1', content_hash: 'same-hash', created_at: '2026-07-01T09:00:00Z' },
  ]
  const result = decideDuplicateFile('same-hash', candidates, 'file-a', 'job-1')
  assert.equal(result.isDuplicate, false)
})

test('decideDuplicateFile: multiple prior matches resolve deterministically to the earliest by created_at', () => {
  const candidates: HashedFileCandidate[] = [
    { id: 'file-later', job_id: 'job-1', content_hash: 'dup-hash', created_at: '2026-07-05T09:00:00Z' },
    { id: 'file-earliest', job_id: 'job-1', content_hash: 'dup-hash', created_at: '2026-07-01T09:00:00Z' },
    { id: 'file-middle', job_id: 'job-1', content_hash: 'dup-hash', created_at: '2026-07-03T09:00:00Z' },
  ]
  const result = decideDuplicateFile('dup-hash', candidates, 'file-newest-upload', 'job-1')
  assert.equal(result.originalFileId, 'file-earliest')
})

test('decideDuplicateFile: multiple prior matches in the SAME job resolve to the earliest even when a different job also shares the hash', () => {
  // Tie-break correctness under the job_id filter: an earlier-created match
  // in a DIFFERENT job must not win over a later-created match in the
  // caller's own job — job scoping is applied before the earliest-wins
  // tie-break, not after.
  const candidates: HashedFileCandidate[] = [
    { id: 'other-job-file', job_id: 'job-99', content_hash: 'dup-hash', created_at: '2026-06-01T09:00:00Z' },
    { id: 'same-job-file', job_id: 'job-1', content_hash: 'dup-hash', created_at: '2026-07-03T09:00:00Z' },
  ]
  const result = decideDuplicateFile('dup-hash', candidates, 'file-newest-upload', 'job-1')
  assert.equal(result.isDuplicate, true)
  assert.equal(result.originalFileId, 'same-job-file')
})

// ─── Regression: same document uploaded twice to the same job, end to end
// at the decision level (production validation pass, downstream impact
// audit) ─────────────────────────────────────────────────────────────────
//
// Scenario: Job A gets document.pdf uploaded, processed, and classified.
// Later, Job A gets the exact same document.pdf uploaded again (a new
// files row, a new document_processing_jobs row — document-worker
// computes the same content_hash, decideDuplicateFile correctly identifies
// it as a duplicate of the first upload, and its job is completed with a
// `duplicate: true` marker instead of ever being extracted). This test
// picks up the story at that point and proves the marker actually does
// what it's for: partitionCompletedJobsForClassification — the real
// function loadAllFromExtractionResults (index.ts) calls before ever
// touching Storage or building Claude content — permanently excludes the
// duplicate's document_id, so it can never reach Stage 1/2, never get a
// project_documents/project_facts row, and therefore never becomes an
// estimator input. This is the one property Phase 1 exists to guarantee;
// it previously had no direct unit coverage (the equivalent filtering used
// to live inline in index.ts, untestable without a live Deno/Supabase
// runtime) until it was extracted into this pure function.
test('partitionCompletedJobsForClassification: REGRESSION — same document uploaded twice to the same job produces exactly one classification candidate and zero for the duplicate', () => {
  const jobsForBatch: CompletedDocumentJobRow[] = [
    // First upload of document.pdf: extracted normally, no duplicate marker.
    { document_id: 'file-document-pdf-upload-1', result: { duplicate: undefined } },
    // Second upload of the SAME document.pdf to the same job: document-worker
    // detected the hash match and completed this job with a duplicate
    // marker instead of ever extracting it.
    { document_id: 'file-document-pdf-upload-2', result: { duplicate: true } },
  ]

  const { toClassify, duplicates } = partitionCompletedJobsForClassification(jobsForBatch)

  // Second upload detected as a duplicate — never sent for classification.
  assert.deepEqual(duplicates, ['file-document-pdf-upload-2'])
  // No second extraction: only the first upload's document_id is eligible
  // to be loaded (loadBlockFromExtractionResult, real Storage I/O) and
  // included in the content Stage 1/2 sends to Claude.
  assert.deepEqual(toClassify, ['file-document-pdf-upload-1'])
  // No duplicate project facts / estimator input unchanged: since the
  // duplicate's document_id never appears in toClassify, it structurally
  // cannot produce a file_index in Claude's response, and therefore cannot
  // produce a project_documents or project_facts row — the fact base Stage
  // 3/6 reason over is exactly what it would have been had the second
  // upload never happened.
  assert.equal(toClassify.includes('file-document-pdf-upload-2'), false)
})

test('partitionCompletedJobsForClassification: a batch with no duplicates classifies every document', () => {
  const jobsForBatch: CompletedDocumentJobRow[] = [
    { document_id: 'file-a', result: { duplicate: undefined } },
    { document_id: 'file-b', result: null },
  ]
  const { toClassify, duplicates } = partitionCompletedJobsForClassification(jobsForBatch)
  assert.deepEqual(toClassify, ['file-a', 'file-b'])
  assert.deepEqual(duplicates, [])
})

// ─── Phase 1 correctness fix: content_hash alone ("we have seen these
// bytes") is not sufficient to identify a canonical document — duplicate
// candidates must be successfully, durably processed
// (project_documents.extraction_status = 'complete', migration 050) ───────

test('filterToCanonicalHashCandidates: Test A — original document succeeds, so a same-bytes re-upload correctly matches it', () => {
  const filesWithHash: HashedFileCandidate[] = [
    { id: 'file-A', job_id: 'job-1', content_hash: 'abc123', created_at: '2026-07-01T09:00:00Z' },
  ]
  // File A was successfully, durably classified — project_documents has a
  // 'complete' row for it.
  const completedFileIds = ['file-A']

  const canonical = filterToCanonicalHashCandidates(filesWithHash, completedFileIds)
  assert.deepEqual(canonical.map((c) => c.id), ['file-A'])

  const decision = decideDuplicateFile('abc123', canonical, 'file-B', 'job-1')
  assert.equal(decision.isDuplicate, true)
  assert.equal(decision.originalFileId, 'file-A')
})

test('filterToCanonicalHashCandidates: Test B — original document FAILS classification, so a same-bytes re-upload is NOT treated as a duplicate and is allowed through extraction', () => {
  // File A was hashed (hashing happens before extraction, unconditionally)
  // but its Stage 1/2 classification never succeeded — no project_documents
  // row reached extraction_status = 'complete' for it. This is the exact
  // poisoning scenario: without the filter, File B (same bytes) would be
  // wrongly marked a duplicate of a document that never contributed
  // anything, and its real content would never reach the estimator no
  // matter how many times it's re-uploaded.
  const filesWithHash: HashedFileCandidate[] = [
    { id: 'file-A', job_id: 'job-1', content_hash: 'abc123', created_at: '2026-07-01T09:00:00Z' },
  ]
  const completedFileIds: string[] = [] // File A never reached extraction_status = 'complete'

  const canonical = filterToCanonicalHashCandidates(filesWithHash, completedFileIds)
  assert.deepEqual(canonical, [])

  const decision = decideDuplicateFile('abc123', canonical, 'file-B', 'job-1')
  // B must be allowed through extraction, not silently skipped.
  assert.equal(decision.isDuplicate, false)
  assert.equal(decision.originalFileId, null)
})

test('filterToCanonicalHashCandidates: Test C — original document still processing (not yet complete) when a same-bytes upload arrives — B is allowed through, matching job_intake_locks\' own intent', () => {
  // In the live pipeline, job_intake_locks (migration 030) serializes
  // processing per job — a second upload session for the same job queues
  // behind the first rather than truly racing it (app/api/intake/[fileId]/
  // route.ts acquires the lock before document-worker is ever triggered),
  // so by the time B's own duplicate check runs, A has already reached a
  // terminal outcome one way or another. This test covers the direct
  // consequence at the decision level regardless of that scheduling detail:
  // extraction_status only reaches 'complete' atomically with A's facts
  // (migration 050) — while A is still mid-pipeline (or was reclaimed/
  // retried and hasn't reached that atomic write yet), it is indistinguishable
  // from Test B's "never succeeded" case to this filter, and B is
  // correctly allowed through rather than blocked on an unfinished original.
  const filesWithHash: HashedFileCandidate[] = [
    { id: 'file-A', job_id: 'job-1', content_hash: 'abc123', created_at: '2026-07-01T09:00:00Z' },
  ]
  const completedFileIds: string[] = [] // A's classification hasn't completed yet

  const canonical = filterToCanonicalHashCandidates(filesWithHash, completedFileIds)
  const decision = decideDuplicateFile('abc123', canonical, 'file-B', 'job-1')
  assert.equal(decision.isDuplicate, false, 'B must be allowed through while A has not yet durably completed')
})

test('filterToCanonicalHashCandidates: a hash match against a NON-canonical file is excluded even when a DIFFERENT canonical file also shares the hash', () => {
  const filesWithHash: HashedFileCandidate[] = [
    { id: 'file-failed', job_id: 'job-1', content_hash: 'abc123', created_at: '2026-07-01T09:00:00Z' },
    { id: 'file-succeeded', job_id: 'job-1', content_hash: 'abc123', created_at: '2026-07-02T09:00:00Z' },
  ]
  const completedFileIds = ['file-succeeded']

  const canonical = filterToCanonicalHashCandidates(filesWithHash, completedFileIds)
  assert.deepEqual(canonical.map((c) => c.id), ['file-succeeded'])

  const decision = decideDuplicateFile('abc123', canonical, 'file-C', 'job-1')
  assert.equal(decision.isDuplicate, true)
  assert.equal(decision.originalFileId, 'file-succeeded')
})

test('filterToCanonicalHashCandidates: passes through unrelated files (different hash) untouched', () => {
  const filesWithHash: HashedFileCandidate[] = [
    { id: 'file-A', job_id: 'job-1', content_hash: 'hash-1', created_at: '2026-07-01T09:00:00Z' },
    { id: 'file-B', job_id: 'job-1', content_hash: 'hash-2', created_at: '2026-07-01T09:05:00Z' },
  ]
  const canonical = filterToCanonicalHashCandidates(filesWithHash, ['file-A', 'file-B'])
  assert.deepEqual(canonical.map((c) => c.id).sort(), ['file-A', 'file-B'])
})

// ─── Non-blocking estimation: conservative assumptions ─────────────────────

test('buildConservativeAssumption: uses Claude\'s own suggested default when supplied', () => {
  const result = buildConservativeAssumption({
    question: 'No structural drawings — what is the footing/slab type?',
    reason: 'Footing type materially changes site works quantities',
    trade_category_id: 1,
    suggested_assumption: 'Standard strip footing, single storey',
  })
  assert.equal(result.assumed_value, 'Standard strip footing, single storey')
  assert.equal(result.question, 'No structural drawings — what is the footing/slab type?')
  assert.equal(result.reason, 'Footing type materially changes site works quantities')
  assert.equal(result.trade_category_id, 1)
  assert.equal(result.confidence_penalty, BLOCKING_ASSUMPTION_CONFIDENCE_PENALTY)
})

test('buildConservativeAssumption: never leaves an assumption blank — falls back to the conservative default when Claude supplied none', () => {
  const result = buildConservativeAssumption({
    question: 'No structural drawings — what is the footing/slab type?',
    reason: 'Footing type materially changes site works quantities',
    trade_category_id: 1,
    suggested_assumption: null,
  })
  assert.equal(result.assumed_value, CONSERVATIVE_ASSUMPTION_FALLBACK)
  assert.ok(result.assumed_value.length > 0)
})

test('buildConservativeAssumption: whitespace-only suggested_assumption is treated as not supplied', () => {
  const result = buildConservativeAssumption({
    question: 'Q', reason: 'R', trade_category_id: null, suggested_assumption: '   ',
  })
  assert.equal(result.assumed_value, CONSERVATIVE_ASSUMPTION_FALLBACK)
})

test('capConfidenceForBlockingTrade: caps high confidence down, never raises low confidence', () => {
  assert.equal(capConfidenceForBlockingTrade(95), BLOCKING_ASSUMPTION_CONFIDENCE_CAP)
  assert.equal(capConfidenceForBlockingTrade(20), 20) // already below the cap — never raised
  assert.equal(capConfidenceForBlockingTrade(BLOCKING_ASSUMPTION_CONFIDENCE_CAP), BLOCKING_ASSUMPTION_CONFIDENCE_CAP)
})

test('conservativeAssumptionAppliesToTrade: matches a specific trade_category_id', () => {
  const assumptions: ConservativeAssumption[] = [
    { question: 'Q', assumed_value: 'V', reason: 'R', confidence_penalty: 60, trade_category_id: 1 },
  ]
  assert.equal(conservativeAssumptionAppliesToTrade(assumptions, 1), true)
  assert.equal(conservativeAssumptionAppliesToTrade(assumptions, 2), false)
})

test('conservativeAssumptionAppliesToTrade: trade_category_id null applies to every trade (project-wide gap)', () => {
  const assumptions: ConservativeAssumption[] = [
    { question: 'Q', assumed_value: 'V', reason: 'R', confidence_penalty: 60, trade_category_id: null },
  ]
  assert.equal(conservativeAssumptionAppliesToTrade(assumptions, 1), true)
  assert.equal(conservativeAssumptionAppliesToTrade(assumptions, 13), true)
})

test('conservativeAssumptionAppliesToTrade: no assumptions means no trade is affected', () => {
  assert.equal(conservativeAssumptionAppliesToTrade([], 1), false)
})

// ─── buildProjectModel ──────────────────────────────────────────────────────

function pmFact(overrides: Partial<BucketableFact>): BucketableFact {
  return {
    category: 'materials', key: 'note', value: 'note', confidence: 80,
    source_document_id: null, evidence: null, ...overrides,
  }
}

test('buildProjectModel: routes a footing fact to structure.foundations', () => {
  const model = buildProjectModel([pmFact({ key: 'footing_type', value: 'Strip footing, 300mm wide' })])
  assert.equal(model.structure.foundations.length, 1)
  assert.equal(model.structure.foundations[0].value, 'Strip footing, 300mm wide')
})

test('buildProjectModel: routes a kitchen benchtop fact to internal.kitchens, not joinery', () => {
  const model = buildProjectModel([pmFact({ key: 'benchtop', value: '40mm stone benchtop' })])
  assert.equal(model.internal.kitchens.length, 1)
  assert.equal(model.internal.joinery.length, 0)
})

test('buildProjectModel: a fact matching no keyword lands in unclassified, never dropped', () => {
  const model = buildProjectModel([pmFact({ key: 'client_preference', value: 'wants a quiet completion date' })])
  assert.equal(model.unclassified.length, 1)
  assert.equal(model.unclassified[0].key, 'client_preference')
})

test('buildProjectModel: total fact count is preserved across every section + unclassified', () => {
  const facts = [
    pmFact({ key: 'footing_type', value: 'strip footing' }),
    pmFact({ key: 'roof_type', value: 'colorbond roof' }),
    pmFact({ key: 'window_count', value: '12 aluminium windows' }),
    pmFact({ key: 'random_note', value: 'nothing structural here' }),
  ]
  const model = buildProjectModel(facts)
  const total =
    model.structure.foundations.length + model.structure.slab.length + model.structure.framing.length + model.structure.roof.length +
    model.external.walls.length + model.external.windows.length + model.external.doors.length + model.external.cladding.length +
    model.internal.flooring.length + model.internal.bathrooms.length + model.internal.kitchens.length + model.internal.joinery.length +
    model.services.electrical.length + model.services.hydraulic.length + model.services.mechanical.length +
    model.site.slope.length + model.site.access.length + model.site.retaining.length + model.site.excavation.length +
    model.unclassified.length
  assert.equal(total, facts.length)
})

test('buildProjectModel: summary.project_type picks the highest-confidence project_type fact', () => {
  const facts = [
    pmFact({ category: 'project_type', key: 'type', value: 'Renovation', confidence: 60 }),
    pmFact({ category: 'project_type', key: 'type', value: 'Rear extension', confidence: 90 }),
  ]
  const model = buildProjectModel(facts)
  assert.equal(model.summary.project_type?.value, 'Rear extension')
})

test('buildProjectModel: summary.floor_area matches on key containing floor_area regardless of category', () => {
  const model = buildProjectModel([pmFact({ category: 'rooms', key: 'floor_area_m2', value: '108.2' })])
  assert.equal(model.summary.floor_area?.value, '108.2')
})

test('buildProjectModel: no matching facts leaves a summary scalar null, not a fabricated default', () => {
  const model = buildProjectModel([pmFact({ key: 'unrelated', value: 'unrelated' })])
  assert.equal(model.summary.project_type, null)
  assert.equal(model.summary.storeys, null)
  assert.equal(model.summary.construction_method, null)
})

test('buildProjectModel: evidence and confidence survive the reorganisation untouched', () => {
  const model = buildProjectModel([pmFact({
    key: 'footing_type', value: 'strip footing', confidence: 72,
    source_document_id: 'doc-1', evidence: 'Structural notes, sheet S1.1',
  })])
  const ref = model.structure.foundations[0]
  assert.equal(ref.confidence, 72)
  assert.equal(ref.source_document_id, 'doc-1')
  assert.equal(ref.evidence, 'Structural notes, sheet S1.1')
})

test('buildProjectModel: empty fact list produces an empty-but-valid model', () => {
  const model = buildProjectModel([])
  assert.equal(model.unclassified.length, 0)
  assert.equal(model.structure.foundations.length, 0)
  assert.equal(model.summary.project_type, null)
})

// ─── Trade views (Phase 3) ──────────────────────────────────────────────────

test('buildTradeViews: routes foundation + slab facts into the concrete view', () => {
  const sections = buildProjectModel([
    pmFact({ key: 'footing_type', value: 'strip footing' }),
    pmFact({ key: 'slab_type', value: 'waffle pod slab' }),
  ])
  const views = buildTradeViews(sections)
  assert.equal(views.concrete.length, 2)
  assert.equal(views.framing.length, 0)
})

test('buildTradeViews: produces exactly the 7 named views, every time', () => {
  const views = buildTradeViews(buildProjectModel([]))
  assert.deepEqual(Object.keys(views).sort(), [...TRADE_VIEW_NAMES].sort())
})

test('viewsForTradeCategory: Site Works & Concrete (trade 1) gets both concrete and site', () => {
  const views = viewsForTradeCategory(1)
  assert.deepEqual(views.sort(), ['concrete', 'site'].sort())
})

test('viewsForTradeCategory: Electrical (trade 12) gets only services', () => {
  assert.deepEqual(viewsForTradeCategory(12), ['services'])
})

test('viewsForTradeCategory: an unknown trade id returns no views rather than throwing', () => {
  assert.deepEqual(viewsForTradeCategory(999), [])
})

test('TRADE_CATEGORY_TO_VIEWS: every one of the 13 real trades has at least one view mapped', () => {
  for (let id = 1; id <= 13; id++) {
    const views: TradeViewName[] = TRADE_CATEGORY_TO_VIEWS[id] ?? []
    assert.ok(views.length > 0, `trade ${id} has no views mapped`)
  }
})

test('formatTradeViewsForPrompt: includes the project summary and only the requested views', () => {
  const sections = buildProjectModel([
    pmFact({ category: 'storeys', key: 'storeys', value: '2' }),
    pmFact({ key: 'footing_type', value: 'strip footing' }),
    pmFact({ key: 'kitchen_benchtop', value: 'stone benchtop' }),
  ])
  const text = formatTradeViewsForPrompt(sections, ['concrete'])
  assert.match(text, /storeys: 2/)
  assert.match(text, /CONCRETE VIEW/)
  assert.match(text, /strip footing/)
  assert.doesNotMatch(text, /benchtop/)
})

// ─── Stage 6 completeness recovery ─────────────────────────────────────────
// Confirmed on a real project: Stage 3 scoped Colorbond roofing/sarking/
// flashings/gutters/skylights/solar PV under a trade, and Stage 6 generated
// ZERO line items for it — a generation gap, not a pricing or taxonomy
// issue. These tests cover requirement 5's four cases: missing trade
// detected, targeted regeneration receives correct scope, existing lines
// are not duplicated, and a failed recovery remains visible.

test('findMissingTrades: a scoped trade with zero line items is detected', () => {
  const scope = [
    { trade_category_id: 3, included_scope: ['Roof framing'] },
    { trade_category_id: 4, included_scope: ['Colorbond roofing', 'sarking', 'flashings', 'gutters', 'skylights', 'solar PV preparation'] },
  ]
  const lineItems = [
    { trade_category_id: 3, assumption_status: null },
  ]
  assert.deepEqual(findMissingTrades(scope, lineItems), [4])
})

test('findMissingTrades: a trade with no included scope is never flagged, even with no line items', () => {
  const scope = [{ trade_category_id: 9, included_scope: [] }]
  assert.deepEqual(findMissingTrades(scope, []), [])
})

test('findMissingTrades: a trade whose only line items are all excluded (Gate 3) still counts as missing', () => {
  const scope = [{ trade_category_id: 4, included_scope: ['Colorbond roofing'] }]
  const lineItems = [{ trade_category_id: 4, assumption_status: 'excluded' }]
  assert.deepEqual(findMissingTrades(scope, lineItems), [4])
})

test('findMissingTrades: a trade already covered by a prior incremental upload\'s line items is not flagged', () => {
  const scope = [{ trade_category_id: 4, included_scope: ['Colorbond roofing'] }]
  const lineItems = [{ trade_category_id: 4, assumption_status: null }]
  assert.deepEqual(findMissingTrades(scope, lineItems), [])
})

test('findMissingTrades: multiple genuinely missing trades are all reported, in scope order', () => {
  const scope = [
    { trade_category_id: 4, included_scope: ['Colorbond roofing'] },
    { trade_category_id: 8, included_scope: ['Kitchen joinery'] },
    { trade_category_id: 11, included_scope: [] },
  ]
  assert.deepEqual(findMissingTrades(scope, []), [4, 8])
})

test('lineItemKey: same trade + description (case/whitespace-insensitive) produces the same key', () => {
  assert.equal(
    lineItemKey(4, 'Colorbond roof sheeting'),
    lineItemKey(4, '  colorbond roof sheeting  '.trim().toUpperCase().toLowerCase())
  )
  assert.notEqual(lineItemKey(4, 'Colorbond roof sheeting'), lineItemKey(3, 'Colorbond roof sheeting'))
})

test('filterNewLineItems: existing lines are not duplicated — a recovered item matching an existing key is dropped', () => {
  const existingKeys = new Set([lineItemKey(4, 'Colorbond roof sheeting')])
  const candidates = [
    { trade_category_id: 4, description: 'Colorbond roof sheeting', assumption_status: null }, // duplicate — must be dropped
    { trade_category_id: 4, description: 'Box gutters', assumption_status: null }, // genuinely new
  ]
  const result = filterNewLineItems(candidates, existingKeys)
  assert.deepEqual(result.map((i) => i.description), ['Box gutters'])
})

test('filterNewLineItems: an excluded (Gate 3) item always passes through regardless of existingKeys', () => {
  const existingKeys = new Set([lineItemKey(4, 'Invalid item')])
  const candidates = [{ trade_category_id: 4, description: 'Invalid item', assumption_status: 'excluded' }]
  const result = filterNewLineItems(candidates, existingKeys)
  assert.equal(result.length, 1)
})

test('buildTradeRecoveryPrompt: targeted regeneration receives the specific trade, its Stage 3 scope, and project facts', () => {
  const scope = {
    trade_category_id: 4,
    included_scope: ['Colorbond roofing', 'sarking', 'flashings', 'gutters', 'skylights', 'solar PV preparation'],
    excluded_scope: ['Structural steel'],
    assumptions: ['Standard AU residential roof pitch'],
  }
  const factsBlock = 'floor_area_m2: 210 (evidence: DA.A101 site data table)'
  const { system, userText } = buildTradeRecoveryPrompt(4, 'External Cladding', scope, factsBlock)

  // Specific trade
  assert.match(system, /trade_category_id 4/)
  assert.match(userText, /TRADE TO GENERATE: 4 \(External Cladding\)/)
  // Stage 3 scope_items for that trade
  assert.match(userText, /Colorbond roofing/)
  assert.match(userText, /sarking/)
  assert.match(userText, /flashings/)
  assert.match(userText, /gutters/)
  assert.match(userText, /skylights/)
  assert.match(userText, /solar PV preparation/)
  assert.match(userText, /Structural steel/)
  assert.match(userText, /Standard AU residential roof pitch/)
  // Relevant project facts already available
  assert.match(userText, /floor_area_m2: 210/)
  // Instruction to generate only missing/this trade's items
  assert.match(system, /ONLY/)
  assert.match(system, /do not generate items for any other trade/i)
})

test('buildTradeRecoveryPrompt: a trade with no excluded_scope/assumptions still produces a usable prompt', () => {
  const scope = { trade_category_id: 7, included_scope: ['Skirting boards'] }
  const { userText } = buildTradeRecoveryPrompt(7, 'Fit-out Carpentry', scope, 'facts here')
  assert.match(userText, /Skirting boards/)
  assert.doesNotMatch(userText, /undefined/)
})

test('buildTradeRecoveryReport: a successful recovery moves a trade from missing to recovered, not remaining', () => {
  const results: TradeRecoveryResult[] = [{ trade_category_id: 4, items_generated: 5 }]
  const report = buildTradeRecoveryReport([4], results)
  assert.deepEqual(report.initial_missing_trades, [4])
  assert.deepEqual(report.recovered_trades, [{ trade_category_id: 4, items_generated: 5 }])
  assert.deepEqual(report.remaining_missing_trades, [])
})

test('buildTradeRecoveryReport: a failed recovery (zero items generated) remains visible in remaining_missing_trades, not silently dropped', () => {
  const results: TradeRecoveryResult[] = [{ trade_category_id: 4, items_generated: 0 }]
  const report = buildTradeRecoveryReport([4], results)
  assert.deepEqual(report.recovered_trades, [])
  assert.deepEqual(report.remaining_missing_trades, [4])
})

test('buildTradeRecoveryReport: mixed outcome across trades — recovered and remaining are reported independently', () => {
  const results: TradeRecoveryResult[] = [
    { trade_category_id: 4, items_generated: 5 },
    { trade_category_id: 8, items_generated: 0 },
  ]
  const report = buildTradeRecoveryReport([4, 8], results)
  assert.deepEqual(report.recovered_trades.map((r) => r.trade_category_id), [4])
  assert.deepEqual(report.remaining_missing_trades, [8])
})

test('isTruncatedResponseError: true for callTool\'s exact max_tokens truncation message', () => {
  const err = new Error(`${TRUNCATED_RESPONSE_PREFIX}4000 — increase the token budget for this stage`)
  assert.equal(isTruncatedResponseError(err), true)
})

test('isTruncatedResponseError: false for an unrelated error, even with similar wording', () => {
  assert.equal(isTruncatedResponseError(new Error('Estimate generation call failed: network timeout')), false)
  assert.equal(isTruncatedResponseError(new Error('token limit exceeded')), false)
})

test('isTruncatedResponseError: false for a non-Error thrown value', () => {
  assert.equal(isTruncatedResponseError('some string'), false)
  assert.equal(isTruncatedResponseError(null), false)
  assert.equal(isTruncatedResponseError(undefined), false)
})

test('shouldRetryTradeRecovery: retries a truncation that has not been retried yet', () => {
  const err = new Error(`${TRUNCATED_RESPONSE_PREFIX}8000 — increase the token budget for this stage`)
  assert.equal(shouldRetryTradeRecovery(err, false), true)
})

test('shouldRetryTradeRecovery: never retries twice, even on a second truncation', () => {
  const err = new Error(`${TRUNCATED_RESPONSE_PREFIX}24000 — increase the token budget for this stage`)
  assert.equal(shouldRetryTradeRecovery(err, true), false)
})

test('shouldRetryTradeRecovery: never retries a non-truncation failure (billing, validation, network)', () => {
  assert.equal(shouldRetryTradeRecovery(new Error('Estimate generation call failed: 400 invalid_request_error'), false), false)
})

test('trade recovery token budgets: the retry ceiling is above both the initial budget and the main Stage 6 budget (16000)', () => {
  assert.ok(TRADE_RECOVERY_INITIAL_MAX_TOKENS > 4000, 'initial budget must exceed the confirmed-insufficient 4000')
  assert.ok(TRADE_RECOVERY_RETRY_MAX_TOKENS > TRADE_RECOVERY_INITIAL_MAX_TOKENS)
  assert.ok(TRADE_RECOVERY_RETRY_MAX_TOKENS > 16000)
})

test('callWithTradeRecoveryRetry: successful trade recovery on the first attempt uses the initial budget and never retries', async () => {
  const calls: number[] = []
  const outcome = await callWithTradeRecoveryRetry(async (maxTokens) => {
    calls.push(maxTokens)
    return { line_items: [{ trade_category_id: 4, description: 'Colorbond roof sheeting' }] }
  })
  assert.deepEqual(calls, [TRADE_RECOVERY_INITIAL_MAX_TOKENS])
  assert.equal(outcome.retryAttempted, false)
  assert.equal(outcome.failureReason, null)
  assert.deepEqual(outcome.result, { line_items: [{ trade_category_id: 4, description: 'Colorbond roof sheeting' }] })
})

test('callWithTradeRecoveryRetry: max_tokens truncation on the first attempt triggers exactly one retry at the higher budget', async () => {
  const calls: number[] = []
  const outcome = await callWithTradeRecoveryRetry(async (maxTokens) => {
    calls.push(maxTokens)
    if (maxTokens === TRADE_RECOVERY_INITIAL_MAX_TOKENS) {
      throw new Error(`${TRUNCATED_RESPONSE_PREFIX}${maxTokens} — increase the token budget for this stage`)
    }
    return { line_items: [{ trade_category_id: 4, description: 'Box gutters' }] }
  })
  assert.deepEqual(calls, [TRADE_RECOVERY_INITIAL_MAX_TOKENS, TRADE_RECOVERY_RETRY_MAX_TOKENS])
  assert.equal(outcome.retryAttempted, true)
  assert.equal(outcome.failureReason, null)
  assert.deepEqual(outcome.result, { line_items: [{ trade_category_id: 4, description: 'Box gutters' }] })
})

test('callWithTradeRecoveryRetry: truncation on both attempts is a visible failure, not a silent continue — exactly one retry, never more', async () => {
  const calls: number[] = []
  const outcome = await callWithTradeRecoveryRetry(async (maxTokens) => {
    calls.push(maxTokens)
    throw new Error(`${TRUNCATED_RESPONSE_PREFIX}${maxTokens} — increase the token budget for this stage`)
  })
  assert.deepEqual(calls, [TRADE_RECOVERY_INITIAL_MAX_TOKENS, TRADE_RECOVERY_RETRY_MAX_TOKENS])
  assert.equal(outcome.result, null)
  assert.equal(outcome.retryAttempted, true)
  assert.match(outcome.failureReason ?? '', /Truncated at 8000 tokens/)
  assert.match(outcome.failureReason ?? '', /retry at 24000 tokens also failed/)
})

test('callWithTradeRecoveryRetry: a non-truncation failure (e.g. billing/validation) is never retried', async () => {
  const calls: number[] = []
  const outcome = await callWithTradeRecoveryRetry(async (maxTokens) => {
    calls.push(maxTokens)
    throw new Error('Estimate generation call failed: 400 invalid_request_error')
  })
  assert.deepEqual(calls, [TRADE_RECOVERY_INITIAL_MAX_TOKENS])
  assert.equal(outcome.retryAttempted, false)
  assert.equal(outcome.failureReason, 'Estimate generation call failed: 400 invalid_request_error')
})

test('no duplicate line items after a retry: items already present (e.g. from a partial first attempt) are filtered out regardless of which attempt produced them', async () => {
  const existingKeys = new Set([lineItemKey(4, 'Colorbond roof sheeting')])
  const outcome = await callWithTradeRecoveryRetry(async (maxTokens) => {
    if (maxTokens === TRADE_RECOVERY_INITIAL_MAX_TOKENS) {
      throw new Error(`${TRUNCATED_RESPONSE_PREFIX}${maxTokens} — increase the token budget for this stage`)
    }
    // The retry's own full response — includes an item that (hypothetically,
    // e.g. from a differently-scoped prior run) already exists on the quote.
    return {
      line_items: [
        { trade_category_id: 4, description: 'Colorbond roof sheeting', assumption_status: null },
        { trade_category_id: 4, description: 'Box gutters', assumption_status: null },
      ],
    }
  })
  const candidates = (outcome.result?.line_items ?? []) as Array<{ trade_category_id: number; description: string; assumption_status: string | null }>
  const toInsert = filterNewLineItems(candidates, existingKeys)
  assert.deepEqual(toInsert.map((i) => i.description), ['Box gutters'])
})

test('buildTradeRecoveryReport: no missing trades at all produces an empty, not null, report', () => {
  const report = buildTradeRecoveryReport([], [])
  assert.deepEqual(report, { initial_missing_trades: [], recovered_trades: [], remaining_missing_trades: [], failures: [] })
})

test('buildTradeRecoveryReport: failures carries full detail (reason + retry_attempted), not just the bare id', () => {
  const results: TradeRecoveryResult[] = [
    { trade_category_id: 4, items_generated: 0, failure_reason: 'Truncated at 8000 tokens; retry at 24000 tokens also failed: still truncated', retry_attempted: true },
  ]
  const report = buildTradeRecoveryReport([4], results)
  assert.deepEqual(report.failures, [results[0]])
  assert.deepEqual(report.remaining_missing_trades, [4])
})

test('formatTradeViewsForPrompt: a view with no matching facts is omitted entirely, not shown empty', () => {
  const sections = buildProjectModel([pmFact({ key: 'footing_type', value: 'strip footing' })])
  const text = formatTradeViewsForPrompt(sections, ['concrete', 'roofing'])
  assert.match(text, /CONCRETE VIEW/)
  assert.doesNotMatch(text, /ROOFING VIEW/)
})
