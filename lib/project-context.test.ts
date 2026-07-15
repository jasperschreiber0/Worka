import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildActiveFactsQuerySpecs,
  buildSupersededFactsQuerySpec,
  assembleProjectContext,
  ACTIVE_FACTS_FETCH_LIMIT,
  RELEVANT_FACTS_FETCH_LIMIT,
  OTHER_FACTS_FETCH_LIMIT,
  SUPERSEDED_HISTORY_LIMIT,
  type ActiveFactRow,
} from './project-context.ts'
import type { FactRow } from '../supabase/functions/smooth-responder/pipeline-logic.ts'

// ─── Query construction (contract tests — no live database) ────────────────
// Per the architecture review's "prefer contract-style tests around query
// construction" guidance: these assert on the SHAPE of what would be
// queried (filters, ordering, limits), not on data returned from a real
// project_facts table. A regression here (e.g. someone flips
// `superseded: false` to `true`, or drops the confidence ordering) fails
// these tests without needing a database at all.

test('buildActiveFactsQuerySpecs: with no relevant categories, one spec covers the full budget (unchanged original behaviour)', () => {
  const specs = buildActiveFactsQuerySpecs(new Set())
  assert.equal(specs.length, 1)
  assert.deepEqual(specs[0], { superseded: false, orderBy: 'confidence', limit: ACTIVE_FACTS_FETCH_LIMIT })
})

test('buildActiveFactsQuerySpecs: with relevant categories, splits into a relevant-category spec and an everything-else spec', () => {
  const specs = buildActiveFactsQuerySpecs(new Set(['finishes', 'kitchens']))
  assert.equal(specs.length, 2)

  assert.equal(specs[0].superseded, false)
  assert.deepEqual(specs[0].categoryIn?.sort(), ['finishes', 'kitchens'])
  assert.equal(specs[0].categoryNotIn, undefined)
  assert.equal(specs[0].orderBy, 'confidence')
  assert.equal(specs[0].limit, RELEVANT_FACTS_FETCH_LIMIT)

  assert.equal(specs[1].superseded, false)
  assert.deepEqual(specs[1].categoryNotIn?.sort(), ['finishes', 'kitchens'])
  assert.equal(specs[1].categoryIn, undefined)
  assert.equal(specs[1].orderBy, 'confidence')
  assert.equal(specs[1].limit, OTHER_FACTS_FETCH_LIMIT)
})

test('buildActiveFactsQuerySpecs: relevant + other budgets always sum to the overall active-fact ceiling', () => {
  assert.equal(RELEVANT_FACTS_FETCH_LIMIT + OTHER_FACTS_FETCH_LIMIT, ACTIVE_FACTS_FETCH_LIMIT)
})

test('buildSupersededFactsQuerySpec: always filters superseded=true, orders by created_at, limited to SUPERSEDED_HISTORY_LIMIT', () => {
  const spec = buildSupersededFactsQuerySpec()
  assert.deepEqual(spec, { superseded: true, orderBy: 'created_at', limit: SUPERSEDED_HISTORY_LIMIT })
})

// ─── assembleProjectContext (pure assembly — no live database) ─────────────

function activeFact(overrides: Partial<ActiveFactRow> & { category: string; key: string; value: string; confidence: number }): ActiveFactRow {
  return { evidence: null, source_document_id: null, ...overrides }
}
function supersededFact(overrides: Partial<FactRow> & { category: string; key: string; value: string; confidence: number }): FactRow {
  return { evidence: null, ...overrides }
}

test('assembleProjectContext: hasData is false with no facts and no scope', () => {
  const ctx = assembleProjectContext([], [], [], [], [], new Set(), { activeFactCount: 0, supersededFactCount: 0 }, { retrievalDurationMs: 5 })
  assert.equal(ctx.hasData, false)
  assert.equal(ctx.confidence, 0)
  assert.deepEqual(ctx.activeFacts, [])
})

test('assembleProjectContext: computes confidence as the average of selected active facts', () => {
  const active: ActiveFactRow[] = [
    activeFact({ category: 'rooms', key: 'a', value: '1', confidence: 80, id: 'f1' }),
    activeFact({ category: 'rooms', key: 'b', value: '2', confidence: 60, id: 'f2' }),
  ]
  const ctx = assembleProjectContext(active, [], [], [], [], new Set(), { activeFactCount: 2, supersededFactCount: 0 }, { retrievalDurationMs: 1 })
  assert.equal(ctx.hasData, true)
  assert.equal(ctx.confidence, 70)
})

test('assembleProjectContext: resolves sourceLabel via the docs map, falling back to document_type then null', () => {
  const active: ActiveFactRow[] = [
    activeFact({ category: 'rooms', key: 'a', value: '1', confidence: 90, id: 'f1', source_document_id: 'doc-1' }),
    activeFact({ category: 'rooms', key: 'b', value: '2', confidence: 90, id: 'f2', source_document_id: 'doc-2' }),
    activeFact({ category: 'rooms', key: 'c', value: '3', confidence: 90, id: 'f3', source_document_id: null }),
  ]
  const docs = [
    { id: 'doc-1', drawing_title: 'Kitchen Elevation', document_type: 'elevation' },
    { id: 'doc-2', drawing_title: null, document_type: 'specification' },
  ]
  const ctx = assembleProjectContext(active, [], [], [], docs, new Set(), { activeFactCount: 3, supersededFactCount: 0 }, { retrievalDurationMs: 1 })
  assert.deepEqual(ctx.activeFacts.map((f) => f.sourceLabel), ['Kitchen Elevation', 'specification', null])
  assert.deepEqual(ctx.documentsReferenced.sort(), ['Kitchen Elevation', 'specification'])
})

test('assembleProjectContext: retrieval metrics report total vs fetched vs selected as distinct numbers', () => {
  const active: ActiveFactRow[] = Array.from({ length: 5 }, (_, i) =>
    activeFact({ category: 'rooms', key: `k${i}`, value: 'v', confidence: 90 - i, id: `f${i}` }))
  const ctx = assembleProjectContext(active, [], [], [], [], new Set(), { activeFactCount: 500, supersededFactCount: 12 }, { retrievalDurationMs: 42 })
  assert.equal(ctx.retrieval.active_fact_count, 500) // total that exist, per the counts param
  assert.equal(ctx.retrieval.active_facts_fetched, 5) // what was actually fetched (below cap here)
  assert.equal(ctx.retrieval.facts_selected, 5) // what survived truncation (no truncation needed here)
  assert.equal(ctx.retrieval.superseded_fact_count, 12)
  assert.equal(ctx.retrieval.retrieval_duration_ms, 42)
  assert.equal(ctx.retrieval.retrieval_strategy, 'confidence_only')
})

test('assembleProjectContext: retrieval_strategy reflects whether relevant categories were inferred', () => {
  const active: ActiveFactRow[] = [activeFact({ category: 'finishes', key: 'a', value: '1', confidence: 90, id: 'f1' })]
  const ctx = assembleProjectContext(active, [], [], [], [], new Set(['finishes']), { activeFactCount: 1, supersededFactCount: 0 }, { retrievalDurationMs: 1 })
  assert.equal(ctx.retrieval.retrieval_strategy, 'relevance_partitioned')
})

test('assembleProjectContext: relevance_changed_selection is true only when truncation actually happens and relevance altered the outcome', () => {
  // Below MAX_FACTS_IN_PROMPT (200) -> no truncation -> relevance cannot have changed anything.
  const small: ActiveFactRow[] = [
    activeFact({ category: 'services', key: 'a', value: '1', confidence: 90, id: 'f1' }),
    activeFact({ category: 'finishes', key: 'b', value: '2', confidence: 50, id: 'f2' }),
  ]
  const ctxSmall = assembleProjectContext(small, [], [], [], [], new Set(['finishes']), { activeFactCount: 2, supersededFactCount: 0 }, { retrievalDurationMs: 1 })
  assert.equal(ctxSmall.retrieval.relevance_changed_selection, false)

  // Force truncation with a relevant-but-low-confidence fact that would
  // lose on confidence alone but should survive via relevance boost.
  const many: ActiveFactRow[] = [
    activeFact({ category: 'finishes', key: 'relevant_low', value: 'x', confidence: 1, id: 'low' }),
    ...Array.from({ length: 200 }, (_, i) =>
      activeFact({ category: 'services', key: `irrelevant_${i}`, value: 'y', confidence: 50 + (i % 40), id: `irr${i}` })),
  ]
  const ctxLarge = assembleProjectContext(many, [], [], [], [], new Set(['finishes']), { activeFactCount: many.length, supersededFactCount: 0 }, { retrievalDurationMs: 1 })
  assert.equal(ctxLarge.retrieval.relevance_changed_selection, true)
  assert.ok(ctxLarge.activeFacts.some((f) => f.key === 'relevant_low'), 'the relevant low-confidence fact should have been promoted into the selection')
})

test('assembleProjectContext: missingInformation and scope pass through from raw rows', () => {
  const scopeRows = [{ trade_category_id: 3, included_scope: ['roof'], excluded_scope: [], assumptions: ['standard tiles'] }]
  const questionRows = [{ question: 'What roof pitch is specified?', reason: 'no drawing shows it' }]
  const ctx = assembleProjectContext([], [], scopeRows, questionRows, [], new Set(), { activeFactCount: 0, supersededFactCount: 0 }, { retrievalDurationMs: 1 })
  assert.equal(ctx.hasData, true) // scope alone counts as data
  assert.deepEqual(ctx.missingInformation, ['What roof pitch is specified?'])
  assert.deepEqual(ctx.scope, [{ tradeCategoryId: 3, included: ['roof'], excluded: [], assumptions: ['standard tiles'] }])
})

test('assembleProjectContext: pairs superseded facts against active replacements and reports the count', () => {
  const active: ActiveFactRow[] = [activeFact({ category: 'rooms', key: 'floor_area_m2', value: '135', confidence: 90, id: 'a1' })]
  const superseded: FactRow[] = [supersededFact({ category: 'rooms', key: 'floor_area_m2', value: '120', confidence: 80 })]
  const ctx = assembleProjectContext(active, superseded, [], [], [], new Set(), { activeFactCount: 1, supersededFactCount: 1 }, { retrievalDurationMs: 1 })
  assert.deepEqual(ctx.recentChanges, [{ category: 'rooms', key: 'floor_area_m2', oldValue: '120', newValue: '135' }])
  assert.equal(ctx.retrieval.superseded_selected, 1)
})
