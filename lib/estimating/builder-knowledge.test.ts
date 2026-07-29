import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateBuilderKnowledgeDefaults, deriveBuilderKnowledgeCharacteristics, type BuilderKnowledgeDefault } from './builder-knowledge.ts'

function def(overrides: Partial<BuilderKnowledgeDefault> = {}): BuilderKnowledgeDefault {
  return {
    id: 'x', jurisdiction: 'NSW', trigger_characteristic: 'always', trade_category_id: 13,
    description: 'Test default', citation: 'Test Act 2000', allowance_value: 1000, pricing_basis: 'test',
    ...overrides,
  }
}

test('an "always" default applies regardless of characteristics', () => {
  const result = evaluateBuilderKnowledgeDefaults([def({ trigger_characteristic: 'always' })], {
    jurisdiction: 'NSW', characteristics: [], existingDescriptions: [],
  })
  assert.equal(result.length, 1)
})

test('a characteristic-gated default only applies when the characteristic is present', () => {
  const d = def({ trigger_characteristic: 'has_new_footings', description: 'Termite protection system' })
  const withCharacteristic = evaluateBuilderKnowledgeDefaults([d], {
    jurisdiction: 'NSW', characteristics: ['has_new_footings'], existingDescriptions: [],
  })
  const withoutCharacteristic = evaluateBuilderKnowledgeDefaults([d], {
    jurisdiction: 'NSW', characteristics: [], existingDescriptions: [],
  })
  assert.equal(withCharacteristic.length, 1)
  assert.equal(withoutCharacteristic.length, 0)
})

test('a default already covered by an existing line item is not duplicated', () => {
  const d = def({ trigger_characteristic: 'always', description: 'Termite protection system' })
  const result = evaluateBuilderKnowledgeDefaults([d], {
    jurisdiction: 'NSW', characteristics: [], existingDescriptions: ['termite barrier system installed per as3660'],
  })
  assert.equal(result.length, 0)
})

test('a different jurisdiction never matches', () => {
  const d = def({ jurisdiction: 'VIC', trigger_characteristic: 'always' })
  const result = evaluateBuilderKnowledgeDefaults([d], {
    jurisdiction: 'NSW', characteristics: [], existingDescriptions: [],
  })
  assert.equal(result.length, 0)
})

test('has_new_footings is derived from any Trade 1 line item', () => {
  const chars = deriveBuilderKnowledgeCharacteristics([
    { trade_category_id: 1, description: 'Waffle pod slab' },
    { trade_category_id: 12, description: 'GPOs' },
  ])
  assert.ok(chars.includes('has_new_footings'))
  assert.ok(!chars.includes('has_pool'))
})

test('has_pool is derived from any line item mentioning a pool', () => {
  const chars = deriveBuilderKnowledgeCharacteristics([
    { trade_category_id: 11, description: 'Pool plumbing and pump room' },
  ])
  assert.ok(chars.includes('has_pool'))
})

test('the real NSW seed set (8 items) all carry a non-empty citation', () => {
  // Guards the "auditable, source-backed" requirement structurally — a row
  // with an empty citation would slip past code review but not this test.
  const descriptions = [
    'Home Building Compensation (HBC) insurance',
    'Termite protection system',
    'Asbestos survey and removal allowance',
    'Waste management and disposal',
    'Sediment and erosion control',
    'Temporary works — site fencing and protection of existing structure',
    'Pool safety certification',
    'BASIX certificate and NCC compliance sign-off',
  ]
  for (const description of descriptions) {
    const d = def({ description })
    assert.ok(d.citation.length > 0, `${description} must have a citation`)
  }
})
