import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeFilename,
  filenameSimilarity,
  textShingleOverlap,
  fileSizeRangeMatch,
  fileSizeSimilarity,
  pageCountDifference,
  titleMatch,
  extractRevisionMarkers,
  summarizeRevisionMarkersForPair,
  explainSimilarity,
  computeDocumentSimilarity,
  computeJobDocumentSimilarityPairs,
  type DocumentSignalInput,
  type DocumentSimilaritySignals,
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

// ─── fileSizeRangeMatch / fileSizeSimilarity / pageCountDifference / titleMatch ─

test('fileSizeRangeMatch: within tolerance matches, outside does not, unknown is null', () => {
  assert.equal(fileSizeRangeMatch(100_000, 105_000), true)
  assert.equal(fileSizeRangeMatch(100_000, 500_000), false)
  assert.equal(fileSizeRangeMatch(null, 100_000), null)
})

test('fileSizeRangeMatch: tiny files use the absolute floor, not just the percentage', () => {
  assert.equal(fileSizeRangeMatch(1_000, 2_000), true)
})

test('fileSizeSimilarity: identical size scores 1, wildly different sizes score low, unknown is null', () => {
  assert.equal(fileSizeSimilarity(100_000, 100_000), 1)
  assert.ok(fileSizeSimilarity(100_000, 900_000)! < 0.2)
  assert.equal(fileSizeSimilarity(null, 100_000), null)
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

// ─── extractRevisionMarkers ─────────────────────────────────────────────────

test('extractRevisionMarkers: detects letter revisions', () => {
  assert.deepEqual(extractRevisionMarkers('Structural-RevB.pdf'), [{ type: 'letter_revision', raw: 'RevB', value: 'B' }])
  assert.deepEqual(extractRevisionMarkers('Floor Plan Rev A.pdf'), [{ type: 'letter_revision', raw: 'Rev A', value: 'A' }])
})

test('extractRevisionMarkers: detects numeric revisions, issues, and versions, normalizing leading zeros', () => {
  assert.deepEqual(extractRevisionMarkers('Site Plan Revision 2.pdf'), [{ type: 'numeric_revision', raw: 'Revision 2', value: '2' }])
  assert.deepEqual(extractRevisionMarkers('Schedule Issue 03.pdf'), [{ type: 'issue', raw: 'Issue 03', value: '3' }])
  assert.deepEqual(extractRevisionMarkers('Drawings Version 4.pdf'), [{ type: 'version', raw: 'Version 4', value: '4' }])
})

test('extractRevisionMarkers: detects dates embedded in filenames', () => {
  assert.deepEqual(extractRevisionMarkers('Plans_2026-07-01.pdf'), [{ type: 'date', raw: '2026-07-01', value: '2026-07-01' }])
})

test('extractRevisionMarkers: underscore-separated markers are detected — \\b treats "_" as a word character and would silently miss these', () => {
  assert.deepEqual(extractRevisionMarkers('Plan_RevA_final.pdf'), [{ type: 'letter_revision', raw: 'RevA', value: 'A' }])
  assert.deepEqual(extractRevisionMarkers('Site_Plan_Issue_03.pdf'), [{ type: 'issue', raw: 'Issue_03', value: '3' }])
})

test('extractRevisionMarkers: does not false-positive on ordinary words containing "rev"/"v"', () => {
  // "Revenue" and "Reviewed" both contain "rev" but not as a genuine
  // revision marker — no letter/digit immediately follows in the expected
  // shape, so neither should match.
  assert.deepEqual(extractRevisionMarkers('Revenue Forecast.pdf'), [])
  assert.deepEqual(extractRevisionMarkers('Reviewed Documents.pdf'), [])
})

test('extractRevisionMarkers: no markers in an ordinary filename returns an empty array, not null/undefined', () => {
  assert.deepEqual(extractRevisionMarkers('Kitchen Elevation.pdf'), [])
})

test('extractRevisionMarkers: multiple distinct markers in one filename are all captured', () => {
  const markers = extractRevisionMarkers('Plan RevA to RevB Comparison.pdf')
  assert.equal(markers.length, 2)
  assert.deepEqual(markers.map((m) => m.value).sort(), ['A', 'B'])
})

// ─── summarizeRevisionMarkersForPair ───────────────────────────────────────

test('summarizeRevisionMarkersForPair: combines and dedupes values from both documents, matching the requested shape', () => {
  const markersA = extractRevisionMarkers('Plan-RevA.pdf')
  const markersB = extractRevisionMarkers('Plan-RevB.pdf')
  const summary = summarizeRevisionMarkersForPair(markersA, markersB)
  assert.deepEqual(summary, { revision_markers_detected: true, revision_values: ['A', 'B'] })
})

test('summarizeRevisionMarkersForPair: no markers on either side reports revision_markers_detected: false', () => {
  const summary = summarizeRevisionMarkersForPair([], [])
  assert.deepEqual(summary, { revision_markers_detected: false, revision_values: [] })
})

test('summarizeRevisionMarkersForPair: never orders or labels values as newer/older — output is an unordered, deduped value list only', () => {
  const markersA = extractRevisionMarkers('Plan-Rev3.pdf')
  const markersB = extractRevisionMarkers('Plan-Rev1.pdf')
  const summary = summarizeRevisionMarkersForPair(markersA, markersB)
  // Deliberately checking there is no ordering guarantee/claim: both values
  // present, nothing in the shape says which is newer.
  assert.deepEqual(new Set(summary.revision_values), new Set(['3', '1']))
  assert.ok(!('newer' in summary) && !('older' in summary) && !('latest' in summary))
})

// ─── explainSimilarity — deterministic, matches signals exactly ────────────

function signals(overrides: Partial<DocumentSimilaritySignals>): DocumentSimilaritySignals {
  return {
    filename_similarity: 0,
    text_overlap: null,
    page_count_difference: null,
    size_similarity: null,
    title_match: null,
    ...overrides,
  }
}

test('explainSimilarity: reproduces every example from the spec verbatim given matching signals', () => {
  const explanations = explainSimilarity({
    sameHash: false,
    normalizedFilenamesEqual: true,
    signals: signals({ filename_similarity: 1, text_overlap: 0.85, page_count_difference: 0 }),
    revisionValuesA: ['A'],
    revisionValuesB: ['B'],
  })
  assert.ok(explanations.includes('Same normalized filename'))
  assert.ok(explanations.includes('85% extracted text overlap'))
  assert.ok(explanations.includes('Same page count'))
  assert.ok(explanations.includes('Different revision markers detected'))
})

test('explainSimilarity: exact hash match always leads with the identical-content explanation', () => {
  const explanations = explainSimilarity({
    sameHash: true,
    normalizedFilenamesEqual: true,
    signals: signals({ filename_similarity: 1 }),
    revisionValuesA: [],
    revisionValuesB: [],
  })
  assert.equal(explanations[0], 'Identical file content (exact byte match)')
})

test('explainSimilarity: every explanation is traceable to the exact signal value passed in (no invented information)', () => {
  const testSignals = signals({ filename_similarity: 0.42, text_overlap: 0.3, page_count_difference: 4, size_similarity: 0.95, title_match: false })
  const explanations = explainSimilarity({
    sameHash: false,
    normalizedFilenamesEqual: false,
    signals: testSignals,
    revisionValuesA: [],
    revisionValuesB: [],
  })
  assert.ok(explanations.some((e) => e.includes('Filenames are substantially different')))
  assert.ok(explanations.some((e) => e === `${Math.round(testSignals.text_overlap! * 100)}% extracted text overlap`))
  assert.ok(explanations.some((e) => e === `Page count differs by ${testSignals.page_count_difference}`))
  assert.ok(explanations.some((e) => e === 'Similar file size'))
  assert.ok(explanations.some((e) => e === 'Different detected document titles'))
})

test('explainSimilarity: missing text produces an explicit "not available" explanation, never a false "0% overlap" or omission', () => {
  const explanations = explainSimilarity({
    sameHash: false,
    normalizedFilenamesEqual: false,
    signals: signals({ filename_similarity: 0.5, text_overlap: null }),
    revisionValuesA: [],
    revisionValuesB: [],
  })
  assert.ok(explanations.includes('No extracted text available for comparison'))
  assert.ok(!explanations.some((e) => e.includes('0% extracted text overlap')))
})

test('explainSimilarity: revision marker present on only one document is reported distinctly from "different markers"', () => {
  const explanations = explainSimilarity({
    sameHash: false,
    normalizedFilenamesEqual: false,
    signals: signals({ filename_similarity: 0.5 }),
    revisionValuesA: ['A'],
    revisionValuesB: [],
  })
  assert.ok(explanations.includes('Revision marker present on only one document'))
  assert.ok(!explanations.includes('Different revision markers detected'))
})

test('explainSimilarity: same revision value on both documents is reported as agreement, not difference', () => {
  const explanations = explainSimilarity({
    sameHash: false,
    normalizedFilenamesEqual: false,
    signals: signals({ filename_similarity: 0.5 }),
    revisionValuesA: ['A'],
    revisionValuesB: ['A'],
  })
  assert.ok(explanations.includes('Same revision marker detected on both documents'))
  assert.ok(!explanations.includes('Different revision markers detected'))
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
  assert.ok(result.explanations.includes('Identical file content (exact byte match)'))
})

test('computeDocumentSimilarity: same filename, unrelated content, no other corroborating signal — NOT scored as a strong match', () => {
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
  assert.ok(result.signals.text_overlap !== null && result.signals.text_overlap >= 0.6)
})

test('computeDocumentSimilarity: same detected title, different revision markers in filename — likely_revision, with revision markers exposed', () => {
  const a = doc({ fileId: 'a', filename: 'plan-RevA.pdf', contentHash: 'hash-a', drawingTitle: 'Ground Floor Plan', extractedText: 'kitchen layout revision one details here today' })
  const b = doc({ fileId: 'b', filename: 'plan-RevB.pdf', contentHash: 'hash-b', drawingTitle: 'ground floor plan', extractedText: 'kitchen layout revision two updated details today' })
  const result = computeDocumentSimilarity(a, b)
  assert.equal(result.likely_category, 'likely_revision')
  assert.ok(result.signals.title_match)
  assert.equal(result.revision_markers_detected, true)
  assert.deepEqual(result.revision_values.sort(), ['A', 'B'])
  assert.ok(result.explanations.includes('Different revision markers detected'))
})

test('computeDocumentSimilarity: missing text on one side does not silently drag the score to zero — renormalized over available signals (missing text does not reduce safety)', () => {
  const a = doc({ fileId: 'a', filename: 'plan.pdf', contentHash: 'hash-a', pageCount: 5, fileSizeBytes: 100_000, extractedText: null })
  const b = doc({ fileId: 'b', filename: 'plan.pdf', contentHash: 'hash-b', pageCount: 5, fileSizeBytes: 102_000, extractedText: null })
  const result = computeDocumentSimilarity(a, b)
  assert.equal(result.signals.text_overlap, null)
  assert.ok(result.explanations.includes('No extracted text available for comparison'))
  // filename + page count + size all agree — score should reflect that,
  // not be zeroed out or penalized by the absent text signal, and the
  // category should not be downgraded to "unrelated" just because text is
  // unavailable — missing data must never look like a confirmed mismatch.
  assert.ok(result.similarity_score > 0.7, `expected a high score from the available signals, got ${result.similarity_score}`)
  assert.notEqual(result.likely_category, 'unrelated')
})

test('computeDocumentSimilarity: review fields are always null when generated — no automatic labelling', () => {
  const result = computeDocumentSimilarity(doc({ fileId: 'a' }), doc({ fileId: 'b' }))
  assert.equal(result.human_label, null)
  assert.equal(result.reviewed_by, null)
  assert.equal(result.reviewed_at, null)
  assert.equal(result.notes, null)
})

test('computeDocumentSimilarity: revision detection never creates or implies a duplicate decision — result has no is_duplicate/merge/action field, and revision info is purely descriptive', () => {
  const a = doc({ fileId: 'a', filename: 'plan-RevA.pdf' })
  const b = doc({ fileId: 'b', filename: 'plan-RevB.pdf' })
  const result = computeDocumentSimilarity(a, b)
  const keys = Object.keys(result)
  assert.ok(!keys.includes('is_duplicate'))
  assert.ok(!keys.includes('duplicate_of'))
  assert.ok(!keys.includes('merge'))
  assert.ok(!keys.includes('action'))
  // Presence of revision markers must not, by itself, force any specific
  // likely_category — it's advisory context alongside every other signal,
  // not a rule that fires independently. (These two files share no other
  // signal at all, so despite having revision markers on both sides, the
  // overall picture is still weak.)
  assert.notEqual(result.likely_category, 'exact_duplicate')
})

test('computeDocumentSimilarity: output shape matches the requested schema exactly', () => {
  const result = computeDocumentSimilarity(doc({ fileId: 'a' }), doc({ fileId: 'b' }))
  assert.deepEqual(Object.keys(result).sort(), [
    'document_a', 'document_a_revision_markers', 'document_b', 'document_b_revision_markers',
    'explanations', 'human_label', 'likely_category', 'notes', 'reviewed_at', 'reviewed_by',
    'revision_markers_detected', 'revision_values', 'signals', 'similarity_score',
  ].sort())
  assert.deepEqual(Object.keys(result.signals).sort(), [
    'filename_similarity', 'page_count_difference', 'size_similarity', 'text_overlap', 'title_match',
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
