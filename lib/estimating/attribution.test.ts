import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getAttributionCategory } from './attribution.ts'

// Relative, .ts-suffixed import (not the @/* alias) — same reasoning as
// quality-gate.test.ts/pipeline-logic.test.ts. attribution.ts's only import
// (database.types.ts) is `import type`, which is fully elided by TypeScript
// stripping, so it never becomes a runtime import plain node would need to
// resolve.

test('ai_extraction_error resolves to worka_error', () => {
  assert.equal(getAttributionCategory('ai_extraction_error'), 'worka_error')
})

test('builder_adjustment resolves to builder_judgement', () => {
  assert.equal(getAttributionCategory('builder_adjustment'), 'builder_judgement')
})

test('client_change resolves to external_change', () => {
  assert.equal(getAttributionCategory('client_change'), 'external_change')
})

test('other resolves to unclassified', () => {
  assert.equal(getAttributionCategory('other'), 'unclassified')
})

test('null reason returns null', () => {
  assert.equal(getAttributionCategory(null), null)
})

test('every assumption resolution reason and variation origin reason classifies', () => {
  const assumptionReasons = [
    'scope_missing',
    'document_unclear',
    'builder_adjustment',
    'market_rate_change',
    'client_change',
    'ai_extraction_error',
    'other',
  ] as const
  const variationReasons = [
    'estimating_error',
    'missing_scope',
    'client_change',
    'site_condition',
    'design_change',
    'supplier_price_change',
    'regulatory_requirement',
    'other',
  ] as const

  for (const reason of assumptionReasons) {
    assert.notEqual(getAttributionCategory(reason), null)
  }
  for (const reason of variationReasons) {
    assert.notEqual(getAttributionCategory(reason), null)
  }
})
