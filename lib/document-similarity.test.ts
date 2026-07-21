import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeFilename,
  filenameSimilarity,
  textShingleOverlap,
  fileSizeRangeMatch,
  pageCountDifference,
  titleMatch,
  computeDocumentSimilarity,
  computeJobDocumentSimilarityPairs,
  type DocumentSignalInput,
} from './document-similarity.ts'

// ─── normalizeFilename ───────────────────────────────────────────────────────

test('normalizeFilename: strips extension, case, and OS duplicate-upload suffixes', () => {
  assert.equal(normalizeFilename('Kitchen Elevation.pdf'), 'kitchen elevation')
  assert.equal(normalizeFilename('Kitchen Elevation (1).pdf'), 'kitchen elevation')
  assert.equal(normalizeFilename('kitchen_elevation-copy.PDF'), 'kitchen elevation')
})

test('normalizeFilename: preserves revision tokens — they are meaningful, not noise', () => {
  assert.equal(normalizeFilename('plan-v1.pdf'), 'plan v1')
  assert.equal(normalizeFilename('plan-v2.pdf'), 'plan v2')
  assert.notEqual(normalizeFilename('plan-v1.pdf'), normalizeFilename('plan-v2.pdf'))
})

// ─── filenameSimilarity ───────────────────────────────────────────────────────

test('filenameSimilarity: identical after normalization scores 1', () => {
  assert.equal(filenameSimilarity('Kitchen Elevation.pdf', 'kitchen_elevation (1).pdf'), 1)
})

test('filenameSimilarity: completely different names score low', () => {
  assert.ok(filenameSimilarity('Kitchen Elevation.pdf', 'Structural Steel Schedule.pdf') < 0.4)
})

test('filenameSimilarity: same filename is never treated as proof on its own (Phase 1 test 2 — must be combined with other signals)', () => {
  // filenameSimilarity alone returning 1 for two files named identically
  // is expected and correct — this function only measures ONE signal; the
  // "not a duplicate just because the name matches" guarantee lives in
  // computeDocumentSimilarity's composite score and Phase 1's actual
  // content_hash detection, not here.
  assert.equal(filenameSimilarity('drawing.pdf', 'drawing.pdf'), 1)
})

// ─── textShingleOverlap ───────────────────────────────────────────────────────

test('textShingleOverlap: identical text scores 1', () => {
  const text = 'the quick brown fox jumps over the lazy dog near the riverbank each morning'
  assert.equal(textShingleOverlap(text, text), 1)
})

test('textShingleOverlap: completely different text scores 0', () => {
  const a = 'the quick brown fox jumps over the lazy dog near the riverbank'
  const b = 'concrete slab specifications for the ground floor structural system'
  assert.equal(textShingleOverlap(a, b), 0)
})

test('textShingleOverlap: returns null (not 0) when either side has no extracted text — unknown, not confirmed different', () => {
  assert.equal(textShingleOverlap(null, 'some text here'), null)
  assert.equal(textShingleOverlap('some text here', null), null)
  assert.equal(textShingleOverlap(null, null), null)
})

// ─── fileSizeRangeMatch / pageCountDifference / titleMatch ───────────────────

test('fileSizeRangeMatch: within tolerance matches, outside does not, unknown is null', () => {
  assert.equal(fileSizeRangeMatch(100_000, 105_000), true)
  assert.equal(fileSizeRangeMatch(100_000, 500_000), false)
  assert.equal(fileSizeRangeMatch(null, 100_000), null)
})

test('fileSizeRangeMatch: tiny files use the absolute floor, not just the percentage', () => {
  // 1000 vs 2000 bytes is a 100% difference — a pure percentage tolerance
  // would reject this, but the 10KB floor means both are "basically empty,
  // don't over-index on noise" and it matches.
  assert.equal(fileSizeRangeMatch(1_000, 2_000), true)
})

test('pageCountDifference: computes absolute difference, null when unknown', () => {
  assert.equal(pageCountDifference(5, 8), 3)
  assert.equal(pageCountDifference(5, 5), 0)
  assert.equal(pageCountDifference(null, 5), null)
})

test('titleMatch: case/whitespace-insensitive equality, null when either side unknown', () => {
  assert.equal(titleMatch('Ground Floor Plan', '  ground floor plan  '), true)
  assert.equal(titleMatch('Ground Floor Plan', 'First Floor Plan'), false)
  assert.equal(titleMatch(null, 'Ground Floor Plan'), null)
})

// ─── computeDocumentSimilarity — composite ────────────────────────────────────

function doc(overrides: Partial<DocumentSignalInput>): DocumentSignalInput {
  return {
    fileId: 'file-x',
    filename: 'document.pdf',
    contentHash: null,
    fileSizeBytes: null,
    pageCount: null,
    drawingTitle: null,
    extractedText: null,
    ...overrides,
  }
}

test('computeDocumentSimilarity: exact content_hash match scores 1 and categorizes as exact_duplicate regardless of other signals', () => {
  const a = doc({ fileId: 'a', filename: 'plan-v1.pdf', contentHash: 'hash-1' })
  const b = doc({ fileId: 'b', filename: 'totally-different-name.pdf', contentHash: 'hash-1' })
  const result = computeDocumentSimilarity(a, b)
  assert.equal(result.similarity_score, 1)
  assert.equal(result.likely_category, 'exact_duplicate')
  assert.ok(result.signals.includes('exact_content_hash_match'))
})

test('computeDocumentSimilarity: same filename, unrelated content, no other corroborating signal — NOT scored as a strong match (mirrors Phase 1 test 2\'s own rule)', () => {
  const a = doc({
    fileId: 'a', filename: 'drawing.pdf', contentHash: 'hash-a',
    pageCount: 3, fileSizeBytes: 200_000,
    extractedText: 'electrical schedule downlights GPOs weatherproof outdoor power points',
  })
  const b = doc({
    fileId: 'b', filename: 'drawing.pdf', contentHash: 'hash-b',
    pageCount: 40, fileSizeBytes: 9_000_000,
    extractedText: 'structural steel beam sizing footing slab reinforcement schedule',
  })
  const result = computeDocumentSimilarity(a, b)
  assert.equal(result.likely_category, 'unrelated')
  assert.ok(result.similarity_score < 0.5, `expected a low score, got ${result.similarity_score}`)
})

test('computeDocumentSimilarity: high text overlap + same page count, different hash — likely_same_document_different_export', () => {
  const sharedText = Array.from({ length: 40 }, (_, i) => `clause ${i} concrete slab reinforcement specification detail`).join(' ')
  const a = doc({ fileId: 'a', filename: 'spec-export1.pdf', contentHash: 'hash-a', pageCount: 12, extractedText: sharedText })
  const b = doc({ fileId: 'b', filename: 'spec-export2.pdf', contentHash: 'hash-b', pageCount: 12, extractedText: sharedText })
  const result = computeDocumentSimilarity(a, b)
  assert.equal(result.likely_category, 'likely_same_document_different_export')
  assert.ok(result.text_overlap !== null && result.text_overlap >= 0.6)
})

test('computeDocumentSimilarity: same detected title, different revision content — likely_revision', () => {
  const a = doc({ fileId: 'a', filename: 'plan-v1.pdf', contentHash: 'hash-a', drawingTitle: 'Ground Floor Plan', extractedText: 'kitchen layout revision one details here today' })
  const b = doc({ fileId: 'b', filename: 'plan-v2.pdf', contentHash: 'hash-b', drawingTitle: 'ground floor plan', extractedText: 'kitchen layout revision two updated details today' })
  const result = computeDocumentSimilarity(a, b)
  assert.equal(result.likely_category, 'likely_revision')
  assert.ok(result.signals.includes('same_detected_title'))
})

test('computeDocumentSimilarity: missing text on one side does not silently drag the score to zero — renormalized over available signals', () => {
  const a = doc({ fileId: 'a', filename: 'plan.pdf', contentHash: 'hash-a', pageCount: 5, fileSizeBytes: 100_000, extractedText: null })
  const b = doc({ fileId: 'b', filename: 'plan.pdf', contentHash: 'hash-b', pageCount: 5, fileSizeBytes: 102_000, extractedText: null })
  const result = computeDocumentSimilarity(a, b)
  assert.equal(result.text_overlap, null)
  assert.ok(result.signals.includes('text_unavailable'))
  // filename + page count + size all agree — score should reflect that,
  // not be zeroed out by the absent text signal.
  assert.ok(result.similarity_score > 0.7, `expected a high score from the available signals, got ${result.similarity_score}`)
})

test('computeDocumentSimilarity: does not mutate or classify — output is purely descriptive fields, no merge/action field exists', () => {
  const a = doc({ fileId: 'a' })
  const b = doc({ fileId: 'b' })
  const result = computeDocumentSimilarity(a, b)
  assert.deepEqual(Object.keys(result).sort(), [
    'document_a', 'document_b', 'filename_similarity', 'likely_category',
    'page_count_difference', 'same_detected_title', 'same_file_size_range',
    'signals', 'similarity_score', 'text_overlap',
  ].sort())
})

// ─── computeJobDocumentSimilarityPairs ─────────────────────────────────────────

test('computeJobDocumentSimilarityPairs: N files produce exactly N*(N-1)/2 unordered pairs, no self-pairs, no duplicate pairs', () => {
  const files = ['a', 'b', 'c', 'd'].map((id) => doc({ fileId: id, filename: `${id}.pdf` }))
  const pairs = computeJobDocumentSimilarityPairs(files)
  assert.equal(pairs.length, 6) // 4*3/2
  const pairKeys = new Set(pairs.map((p) => `${p.document_a}:${p.document_b}`))
  assert.equal(pairKeys.size, 6)
  assert.ok(pairs.every((p) => p.document_a !== p.document_b))
})

test('computeJobDocumentSimilarityPairs: empty or single-file input produces no pairs', () => {
  assert.equal(computeJobDocumentSimilarityPairs([]).length, 0)
  assert.equal(computeJobDocumentSimilarityPairs([doc({ fileId: 'a' })]).length, 0)
})
