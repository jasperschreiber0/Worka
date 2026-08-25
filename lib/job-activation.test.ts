import { test } from 'node:test'
import assert from 'node:assert/strict'
// Relative, .ts-suffixed import — same reason job-closeout.test.ts/invoices.test.ts
// document: must resolve identically under plain `node --experimental-strip-types`
// and under Next.js/webpack.
import { planActivationRepair } from './job-activation.ts'

test('planActivationRepair: a non-current quote is never repaired, regardless of other state', () => {
  const plan = planActivationRepair({ isCurrentQuote: false, quoteApproved: false, milestoneCount: 0, scheduleCount: 0 })
  assert.equal(plan.allowRepair, false)
  assert.equal(plan.fullyComplete, false)
  assert.equal(plan.needsQuoteApproval, false)
  assert.equal(plan.needsMilestones, false)
  assert.equal(plan.needsInvoiceSchedule, false)
})

test('planActivationRepair: everything already persisted is fully complete — nothing to do', () => {
  const plan = planActivationRepair({ isCurrentQuote: true, quoteApproved: true, milestoneCount: 8, scheduleCount: 5 })
  assert.equal(plan.allowRepair, true)
  assert.equal(plan.fullyComplete, true)
  assert.equal(plan.needsQuoteApproval, false)
  assert.equal(plan.needsMilestones, false)
  assert.equal(plan.needsInvoiceSchedule, false)
})

test('planActivationRepair: nothing persisted yet needs all three steps (equivalent to a fresh activation)', () => {
  const plan = planActivationRepair({ isCurrentQuote: true, quoteApproved: false, milestoneCount: 0, scheduleCount: 0 })
  assert.equal(plan.allowRepair, true)
  assert.equal(plan.fullyComplete, false)
  assert.equal(plan.needsQuoteApproval, true)
  assert.equal(plan.needsMilestones, true)
  assert.equal(plan.needsInvoiceSchedule, true)
})

test('planActivationRepair: only the quote approval write failed — resume just that step', () => {
  const plan = planActivationRepair({ isCurrentQuote: true, quoteApproved: false, milestoneCount: 8, scheduleCount: 5 })
  assert.equal(plan.fullyComplete, false)
  assert.equal(plan.needsQuoteApproval, true)
  assert.equal(plan.needsMilestones, false)
  assert.equal(plan.needsInvoiceSchedule, false)
})

test('planActivationRepair: only the milestone insert failed — resume just that step', () => {
  const plan = planActivationRepair({ isCurrentQuote: true, quoteApproved: true, milestoneCount: 0, scheduleCount: 5 })
  assert.equal(plan.fullyComplete, false)
  assert.equal(plan.needsQuoteApproval, false)
  assert.equal(plan.needsMilestones, true)
  assert.equal(plan.needsInvoiceSchedule, false)
})

test('planActivationRepair: only the invoice schedule insert failed — resume just that step', () => {
  const plan = planActivationRepair({ isCurrentQuote: true, quoteApproved: true, milestoneCount: 8, scheduleCount: 0 })
  assert.equal(plan.fullyComplete, false)
  assert.equal(plan.needsQuoteApproval, false)
  assert.equal(plan.needsMilestones, false)
  assert.equal(plan.needsInvoiceSchedule, true)
})
