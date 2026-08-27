import { test } from 'node:test'
import assert from 'node:assert/strict'
// Relative, .ts-suffixed import — same reason job-closeout.test.ts/invoices.test.ts
// document: must resolve identically under plain `node --experimental-strip-types`
// and under Next.js/webpack.
import { planActivationRepair } from './job-activation.ts'

test('planActivationRepair: a non-current quote is never repaired, regardless of other state', () => {
  const plan = planActivationRepair({ isCurrentQuote: false, quoteApproved: false, milestoneCount: 0, scheduleCount: 0, scheduleAmountTotal: 0, scheduleHasLinkedInvoice: false, contractValue: 50000 })
  assert.equal(plan.allowRepair, false)
  assert.equal(plan.fullyComplete, false)
  assert.equal(plan.needsQuoteApproval, false)
  assert.equal(plan.needsMilestones, false)
  assert.equal(plan.needsInvoiceSchedule, false)
  assert.equal(plan.needsInvoiceScheduleRepair, false)
})

test('planActivationRepair: everything already persisted and healthy (non-zero schedule) is fully complete — nothing to do', () => {
  const plan = planActivationRepair({ isCurrentQuote: true, quoteApproved: true, milestoneCount: 8, scheduleCount: 5, scheduleAmountTotal: 50000, scheduleHasLinkedInvoice: false, contractValue: 50000 })
  assert.equal(plan.allowRepair, true)
  assert.equal(plan.fullyComplete, true)
  assert.equal(plan.needsQuoteApproval, false)
  assert.equal(plan.needsMilestones, false)
  assert.equal(plan.needsInvoiceSchedule, false)
  assert.equal(plan.needsInvoiceScheduleRepair, false)
})

test('planActivationRepair: nothing persisted yet needs all three steps (equivalent to a fresh activation)', () => {
  const plan = planActivationRepair({ isCurrentQuote: true, quoteApproved: false, milestoneCount: 0, scheduleCount: 0, scheduleAmountTotal: 0, scheduleHasLinkedInvoice: false, contractValue: 50000 })
  assert.equal(plan.allowRepair, true)
  assert.equal(plan.fullyComplete, false)
  assert.equal(plan.needsQuoteApproval, true)
  assert.equal(plan.needsMilestones, true)
  assert.equal(plan.needsInvoiceSchedule, true)
  assert.equal(plan.needsInvoiceScheduleRepair, false)
})

test('planActivationRepair: only the quote approval write failed — resume just that step', () => {
  const plan = planActivationRepair({ isCurrentQuote: true, quoteApproved: false, milestoneCount: 8, scheduleCount: 5, scheduleAmountTotal: 50000, scheduleHasLinkedInvoice: false, contractValue: 50000 })
  assert.equal(plan.fullyComplete, false)
  assert.equal(plan.needsQuoteApproval, true)
  assert.equal(plan.needsMilestones, false)
  assert.equal(plan.needsInvoiceSchedule, false)
  assert.equal(plan.needsInvoiceScheduleRepair, false)
})

test('planActivationRepair: only the milestone insert failed — resume just that step', () => {
  const plan = planActivationRepair({ isCurrentQuote: true, quoteApproved: true, milestoneCount: 0, scheduleCount: 5, scheduleAmountTotal: 50000, scheduleHasLinkedInvoice: false, contractValue: 50000 })
  assert.equal(plan.fullyComplete, false)
  assert.equal(plan.needsQuoteApproval, false)
  assert.equal(plan.needsMilestones, true)
  assert.equal(plan.needsInvoiceSchedule, false)
  assert.equal(plan.needsInvoiceScheduleRepair, false)
})

test('planActivationRepair: no schedule rows exist at all — insert a fresh set (not a repair)', () => {
  const plan = planActivationRepair({ isCurrentQuote: true, quoteApproved: true, milestoneCount: 8, scheduleCount: 0, scheduleAmountTotal: 0, scheduleHasLinkedInvoice: false, contractValue: 50000 })
  assert.equal(plan.fullyComplete, false)
  assert.equal(plan.needsQuoteApproval, false)
  assert.equal(plan.needsMilestones, false)
  assert.equal(plan.needsInvoiceSchedule, true)
  assert.equal(plan.needsInvoiceScheduleRepair, false)
})

// ─── Round 9 fix: poisoned $0 invoice schedule detection ──────────────────

test('planActivationRepair: a genuinely $0 contract with a $0 schedule is NOT flagged as poisoned', () => {
  const plan = planActivationRepair({ isCurrentQuote: true, quoteApproved: true, milestoneCount: 8, scheduleCount: 5, scheduleAmountTotal: 0, scheduleHasLinkedInvoice: false, contractValue: 0 })
  assert.equal(plan.fullyComplete, true)
  assert.equal(plan.needsInvoiceSchedule, false)
  assert.equal(plan.needsInvoiceScheduleRepair, false)
})

test('planActivationRepair: a $0 schedule against a non-zero contract IS flagged as poisoned and needs repair, not a fresh insert', () => {
  const plan = planActivationRepair({ isCurrentQuote: true, quoteApproved: true, milestoneCount: 8, scheduleCount: 5, scheduleAmountTotal: 0, scheduleHasLinkedInvoice: false, contractValue: 450000 })
  assert.equal(plan.allowRepair, true)
  assert.equal(plan.fullyComplete, false)
  assert.equal(plan.needsQuoteApproval, false)
  assert.equal(plan.needsMilestones, false)
  assert.equal(plan.needsInvoiceSchedule, false)
  assert.equal(plan.needsInvoiceScheduleRepair, true)
})

test('planActivationRepair: a poisoned schedule with ANY row already linked to a real invoice is never repaired', () => {
  const plan = planActivationRepair({ isCurrentQuote: true, quoteApproved: true, milestoneCount: 8, scheduleCount: 5, scheduleAmountTotal: 0, scheduleHasLinkedInvoice: true, contractValue: 450000 })
  assert.equal(plan.fullyComplete, true)
  assert.equal(plan.needsInvoiceSchedule, false)
  assert.equal(plan.needsInvoiceScheduleRepair, false)
})

test('planActivationRepair: repeated repair is idempotent — once the schedule is healthy, a second call finds nothing left to do', () => {
  // Simulates calling the function again with the state AFTER a successful
  // repair (fresh rows summing to the real contract value) — must not
  // re-flag for repair a second time.
  const afterRepair = planActivationRepair({ isCurrentQuote: true, quoteApproved: true, milestoneCount: 8, scheduleCount: 5, scheduleAmountTotal: 450000, scheduleHasLinkedInvoice: false, contractValue: 450000 })
  assert.equal(afterRepair.fullyComplete, true)
  assert.equal(afterRepair.needsInvoiceSchedule, false)
  assert.equal(afterRepair.needsInvoiceScheduleRepair, false)
})

test('planActivationRepair: a non-zero but partial schedule total (not exactly $0) is left alone — only an exact $0 total is treated as poisoned', () => {
  // A schedule that's merely a different total than expected (e.g. from a
  // legitimate prior contract-value change) is not this bug's signature —
  // only an exact $0 sum against a non-zero contract is. Avoids the repair
  // mechanism ever overwriting a schedule for a reason unrelated to this
  // specific defect.
  const plan = planActivationRepair({ isCurrentQuote: true, quoteApproved: true, milestoneCount: 8, scheduleCount: 5, scheduleAmountTotal: 12345, scheduleHasLinkedInvoice: false, contractValue: 450000 })
  assert.equal(plan.fullyComplete, true)
  assert.equal(plan.needsInvoiceSchedule, false)
  assert.equal(plan.needsInvoiceScheduleRepair, false)
})
