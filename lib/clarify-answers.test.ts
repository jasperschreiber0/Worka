import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldResumeAfterClarify,
  failedQuestionIds,
  isDuplicateBuilderAnswerFact,
} from './clarify-answers.ts'

// ─── shouldResumeAfterClarify ───────────────────────────────────────────────

test('shouldResumeAfterClarify: all answers persisted -> resume (unchanged success path)', () => {
  assert.equal(
    shouldResumeAfterClarify([
      { questionId: 'q1', factPersisted: true },
      { questionId: 'q2', factPersisted: true },
    ]),
    true
  )
})

test('shouldResumeAfterClarify: no answer matched a real clarifying_questions row -> resume anyway (pre-existing behavior, unrelated to the fact-persistence failure this fix closes)', () => {
  assert.equal(shouldResumeAfterClarify([]), true)
})

test('shouldResumeAfterClarify: one answer failed to persist -> do not resume', () => {
  assert.equal(
    shouldResumeAfterClarify([
      { questionId: 'q1', factPersisted: true },
      { questionId: 'q2', factPersisted: false },
    ]),
    false
  )
})

test('shouldResumeAfterClarify: every answer failed to persist -> do not resume', () => {
  assert.equal(
    shouldResumeAfterClarify([
      { questionId: 'q1', factPersisted: false },
      { questionId: 'q2', factPersisted: false },
    ]),
    false
  )
})

// ─── failedQuestionIds ───────────────────────────────────────────────────────

test('failedQuestionIds: reports only the failed ones, preserving order', () => {
  assert.deepEqual(
    failedQuestionIds([
      { questionId: 'q1', factPersisted: true },
      { questionId: 'q2', factPersisted: false },
      { questionId: 'q3', factPersisted: false },
    ]),
    ['q2', 'q3']
  )
})

test('failedQuestionIds: empty when nothing failed', () => {
  assert.deepEqual(failedQuestionIds([{ questionId: 'q1', factPersisted: true }]), [])
})

// ─── isDuplicateBuilderAnswerFact ───────────────────────────────────────────

test('isDuplicateBuilderAnswerFact: no existing fact -> not a duplicate, safe to insert', () => {
  assert.equal(
    isDuplicateBuilderAnswerFact(null, { category: 'builder_answer', key: 'Slab thickness?', value: '150mm' }),
    false
  )
})

test('isDuplicateBuilderAnswerFact: exact match, not superseded -> duplicate, skip insert', () => {
  assert.equal(
    isDuplicateBuilderAnswerFact(
      { category: 'builder_answer', key: 'Slab thickness?', value: '150mm', superseded: false },
      { category: 'builder_answer', key: 'Slab thickness?', value: '150mm' }
    ),
    true
  )
})

test('isDuplicateBuilderAnswerFact: exact match but superseded -> not a duplicate (a corrected/newer answer must still be able to insert)', () => {
  assert.equal(
    isDuplicateBuilderAnswerFact(
      { category: 'builder_answer', key: 'Slab thickness?', value: '150mm', superseded: true },
      { category: 'builder_answer', key: 'Slab thickness?', value: '150mm' }
    ),
    false
  )
})

test('isDuplicateBuilderAnswerFact: same key, different value (a genuinely corrected answer) -> not a duplicate', () => {
  assert.equal(
    isDuplicateBuilderAnswerFact(
      { category: 'builder_answer', key: 'Slab thickness?', value: '150mm', superseded: false },
      { category: 'builder_answer', key: 'Slab thickness?', value: '200mm' }
    ),
    false
  )
})

test('isDuplicateBuilderAnswerFact: same value, different key (a different question) -> not a duplicate', () => {
  assert.equal(
    isDuplicateBuilderAnswerFact(
      { category: 'builder_answer', key: 'Slab thickness?', value: '150mm', superseded: false },
      { category: 'builder_answer', key: 'Roof pitch?', value: '150mm' }
    ),
    false
  )
})
