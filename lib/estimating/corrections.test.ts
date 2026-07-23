import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  retrieveRelevantCorrections,
  formatCorrectionsForPrompt,
  CORRECTION_MIN_SIMILARITY,
  type CorrectionCandidate,
} from './corrections.ts'
import type { ProjectMetadata, SimilarProject } from '../types/estimation.types.ts'

// ─── Fixtures ───────────────────────────────────────────────────────────────

function metadata(overrides: Partial<ProjectMetadata> = {}): ProjectMetadata {
  return {
    job_type: 'rear_extension', renovation_type: 'extension', project_summary: '',
    floor_area_m2: 100, storeys: 1, wet_areas: 1, bedrooms: 3,
    finish_level: 'standard', construction_type: 'timber_frame', region: 'NSW', suburb: null,
    ...overrides,
  }
}

function jobMeta(overrides: Partial<SimilarProject> = {}): SimilarProject {
  return {
    id: 'job-x', job_type: 'rear_extension', project_summary: '',
    floor_area_m2: 100, storeys: 1, wet_areas: 1, finish_level: 'standard', region: 'NSW', suburb: null,
    quoted_cost: null, final_cost: null, quoted_margin_pct: null, final_margin_pct: null,
    completed_at: null, similarity_score: 0,
    ...overrides,
  }
}

function candidate(overrides: Partial<CorrectionCandidate> = {}): CorrectionCandidate {
  return {
    id: 'corr-1', trade_category_id: 4, field: 'quantity',
    ai_predicted: '450', human_corrected: '520', reason: 'Additional garage walls',
    job_metadata: jobMeta(),
    ...overrides,
  }
}

// ─── retrieveRelevantCorrections ────────────────────────────────────────────

test('retrieveRelevantCorrections: a highly similar project surfaces above the floor', () => {
  const result = retrieveRelevantCorrections([candidate()], metadata(), 4)
  assert.equal(result.length, 1)
  assert.ok(result[0].similarity_score >= CORRECTION_MIN_SIMILARITY)
})

test('retrieveRelevantCorrections: filters out a different trade entirely', () => {
  const result = retrieveRelevantCorrections([candidate({ trade_category_id: 12 })], metadata(), 4)
  assert.equal(result.length, 0)
})

test('retrieveRelevantCorrections: an unrelated project scores below the floor and is excluded', () => {
  const unrelated = candidate({
    job_metadata: jobMeta({ job_type: 'granny_flat', floor_area_m2: 900, region: 'WA', finish_level: 'luxury', storeys: 2, wet_areas: 4 }),
  })
  const result = retrieveRelevantCorrections([unrelated], metadata(), 4)
  assert.equal(result.length, 0)
})

test('retrieveRelevantCorrections: sorts by similarity, most similar first', () => {
  const lessSimilar = candidate({ id: 'corr-low', job_metadata: jobMeta({ region: 'VIC', finish_level: 'premium' }) })
  const mostSimilar = candidate({ id: 'corr-high', job_metadata: jobMeta() })
  const result = retrieveRelevantCorrections([lessSimilar, mostSimilar], metadata(), 4)
  assert.equal(result[0].id, 'corr-high')
  assert.ok(result[0].similarity_score >= result[1]?.similarity_score ?? 0)
})

test('retrieveRelevantCorrections: respects the limit', () => {
  const many = Array.from({ length: 10 }, (_, i) => candidate({ id: `corr-${i}` }))
  const result = retrieveRelevantCorrections(many, metadata(), 4, 3)
  assert.equal(result.length, 3)
})

test('retrieveRelevantCorrections: empty candidates returns empty, never throws', () => {
  assert.deepEqual(retrieveRelevantCorrections([], metadata(), 4), [])
})

// ─── formatCorrectionsForPrompt ─────────────────────────────────────────────

test('formatCorrectionsForPrompt: empty input returns empty string', () => {
  assert.equal(formatCorrectionsForPrompt([]), '')
})

test('formatCorrectionsForPrompt: includes predicted, corrected, and reason when present', () => {
  const ranked = retrieveRelevantCorrections([candidate()], metadata(), 4)
  const text = formatCorrectionsForPrompt(ranked)
  assert.match(text, /450/)
  assert.match(text, /520/)
  assert.match(text, /Additional garage walls/)
})

test('formatCorrectionsForPrompt: a Gate-1 correction with no prior value reads as "no value", not "null"', () => {
  const ranked = retrieveRelevantCorrections([candidate({ ai_predicted: null })], metadata(), 4)
  const text = formatCorrectionsForPrompt(ranked)
  assert.match(text, /no value/)
  assert.doesNotMatch(text, /null/)
})
