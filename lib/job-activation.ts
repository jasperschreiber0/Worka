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
//
// FIX (Round 9 reliability audit, persistence truthfulness): a schedule
// EXISTING was never sufficient to prove it was correct. The route's own
// contract-value read (quote_line_items -> calculateClientPrice) used to be
// unchecked — on a transient failure it silently computed a $0 contract
// value, and every generated invoice_schedule row was inserted at
// amount:0. Because this module only ever checked `scheduleCount === 0`,
// five real $0 rows counted as "already done": every future repair
// attempt saw fullyComplete and returned the unchanged 409, permanently
// hiding the poisoned schedule from the only mechanism that could fix it.
// `scheduleAmountTotal`/`contractValue`/`scheduleHasLinkedInvoice` let this
// module tell a genuinely $0 contract (nothing wrong — never flagged) apart
// from a real contract whose schedule was zeroed out by that read failure
// (flagged as `needsInvoiceScheduleRepair`, distinct from
// `needsInvoiceSchedule` so the route can safely replace the poisoned rows
// instead of inserting a duplicate second set alongside them).

export interface ActivationCompletionState {
  /** quotes.is_current (migration 061) — the job's one canonical quote. A
   *  non-current quote_id is an ambiguous case this module deliberately
   *  refuses to repair, rather than guessing. */
  isCurrentQuote: boolean
  quoteApproved: boolean
  milestoneCount: number
  scheduleCount: number
  /** Sum of every existing invoice_schedule row's `amount` for this job. */
  scheduleAmountTotal: number
  /** true if ANY existing schedule row already has `invoice_id` set — a
   *  stage a real invoice already depends on. A $0 stage can never have
   *  been invoiced (the invoice-creation route rejects amount<=0), so this
   *  should never be true on a genuinely poisoned schedule — checked
   *  anyway as an independent guard: repair is never attempted if it is. */
  scheduleHasLinkedInvoice: boolean
  /** The freshly (re)computed client contract value for this activation —
   *  the same figure a fresh schedule would be generated from. */
  contractValue: number
}

export interface ActivationRepairPlan {
  /** false: leave the existing "already active" 409 behaviour untouched — no writes, no repair attempted. */
  allowRepair: boolean
  /** true: every required artifact already exists and is correct — same as allowRepair=false's 409 outcome, kept distinct for clarity/testability. */
  fullyComplete: boolean
  needsQuoteApproval: boolean
  needsMilestones: boolean
  /** true: no invoice_schedule rows exist at all — insert a fresh set. */
  needsInvoiceSchedule: boolean
  /** true: invoice_schedule rows exist but sum to $0 against a non-zero
   *  contract value, and none is linked to a real invoice — replace them,
   *  never insert alongside them. Mutually exclusive with
   *  needsInvoiceSchedule (a schedule can't simultaneously not exist and
   *  need replacing). */
  needsInvoiceScheduleRepair: boolean
}

export function planActivationRepair(state: ActivationCompletionState): ActivationRepairPlan {
  if (!state.isCurrentQuote) {
    return { allowRepair: false, fullyComplete: false, needsQuoteApproval: false, needsMilestones: false, needsInvoiceSchedule: false, needsInvoiceScheduleRepair: false }
  }

  const needsQuoteApproval = !state.quoteApproved
  const needsMilestones = state.milestoneCount === 0

  const scheduleMissing = state.scheduleCount === 0
  const schedulePoisoned = !scheduleMissing
    && state.scheduleAmountTotal === 0
    && state.contractValue > 0
    && !state.scheduleHasLinkedInvoice

  const needsInvoiceSchedule = scheduleMissing
  const needsInvoiceScheduleRepair = schedulePoisoned

  const fullyComplete = !needsQuoteApproval && !needsMilestones && !needsInvoiceSchedule && !needsInvoiceScheduleRepair

  return { allowRepair: true, fullyComplete, needsQuoteApproval, needsMilestones, needsInvoiceSchedule, needsInvoiceScheduleRepair }
}
