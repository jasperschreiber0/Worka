// ─── Job Activation — incomplete-activation repair decision ────────────────
//
// Pure decision logic only. `app/api/jobs/[jobId]/activate/route.ts` owns
// every DB read/write; this module just turns the state it already has
// (from real DB checks — quotes.is_current, quotes.status, and existence
// counts on job_milestones/invoice_schedule) into what to do next.
//
// Context: job activation's downstream writes (quote approval,
// job_milestones insert, invoice_schedule insert) were previously
// unchecked — a mid-sequence failure could leave `jobs.status = 'active'`
// with none of them persisted, while the route still reported success. The
// atomic claim that flips jobs.status is forward-only and one-shot
// (`.in('status', ['quoting','quoted'])`), so once a job is 'active' a
// naive retry can never re-claim it — the route needs to distinguish a
// genuinely fully-activated job (nothing to do, existing 409 behaviour
// unchanged) from a demonstrably incomplete one (resume only what's
// missing) using real persisted state, never a heuristic or a blind
// "re-run everything" repair.

export interface ActivationCompletionState {
  /** quotes.is_current (migration 061) — the job's one canonical quote. A
   *  non-current quote_id is an ambiguous case this module deliberately
   *  refuses to repair, rather than guessing. */
  isCurrentQuote: boolean
  quoteApproved: boolean
  milestoneCount: number
  scheduleCount: number
}

export interface ActivationRepairPlan {
  /** false: leave the existing "already active" 409 behaviour untouched — no writes, no repair attempted. */
  allowRepair: boolean
  /** true: every required artifact already exists — same as allowRepair=false's 409 outcome, kept distinct for clarity/testability. */
  fullyComplete: boolean
  needsQuoteApproval: boolean
  needsMilestones: boolean
  needsInvoiceSchedule: boolean
}

export function planActivationRepair(state: ActivationCompletionState): ActivationRepairPlan {
  if (!state.isCurrentQuote) {
    return { allowRepair: false, fullyComplete: false, needsQuoteApproval: false, needsMilestones: false, needsInvoiceSchedule: false }
  }

  const needsQuoteApproval = !state.quoteApproved
  const needsMilestones = state.milestoneCount === 0
  const needsInvoiceSchedule = state.scheduleCount === 0
  const fullyComplete = !needsQuoteApproval && !needsMilestones && !needsInvoiceSchedule

  return { allowRepair: true, fullyComplete, needsQuoteApproval, needsMilestones, needsInvoiceSchedule }
}
