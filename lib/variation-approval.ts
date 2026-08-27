// Pure decision logic for the variation-approval persistence-truthfulness fix
// (Round 5 reliability audit finding). applyApprovedVariationToQuote()
// (lib/variations.ts) already checks its own write and returns a typed
// ApplyVariationResult instead of throwing — the defect this fix closes is
// that every caller (both approval routes, the client approval page) threw
// that result away: no server-side log on failure, and the client-facing
// page told the client "Approved!" with no distinction from a genuine
// contract update. This module is the one shared place that decision now
// lives, so the route-level logging trigger and the UI's displayed state
// can never drift apart from each other.

export interface ContractEffectLike {
  applied: boolean
  reason?: string
}

export type ApprovalDecision = 'approved' | 'rejected'

/**
 * Whether a caller should log a structured server-side error for this
 * outcome. Only meaningful for an 'approved' decision — a rejection never
 * calls applyApprovedVariationToQuote at all (contractEffect is null/undefined
 * for that path), so there's nothing to log.
 */
export function shouldLogContractApplicationFailure(
  decision: ApprovalDecision,
  contractEffect: ContractEffectLike | null | undefined
): boolean {
  return decision === 'approved' && contractEffect != null && contractEffect.applied === false
}

export type ApprovalOutcomeDisplay = 'approved_and_applied' | 'approved_but_not_applied' | 'rejected'

/**
 * What the client-facing approval page should show. The variation's own
 * approved/rejected status is never in question here (that write is already
 * atomic and checked) — only whether the contract price update that's
 * supposed to follow an approval actually landed. Never claims the contract
 * has changed unless contractEffect confirms it.
 */
export function describeApprovalOutcome(
  decision: ApprovalDecision,
  contractEffect: ContractEffectLike | null | undefined
): ApprovalOutcomeDisplay {
  if (decision === 'rejected') return 'rejected'
  if (contractEffect != null && contractEffect.applied === false) return 'approved_but_not_applied'
  return 'approved_and_applied'
}

/**
 * Whether a builder-triggered retry of the contract application is safe to
 * attempt right now. Mirrors the exact precondition
 * applyApprovedVariationToQuote's own idempotency guard already relies on
 * (a unique constraint on quote_line_items.variation_id) — checked here
 * explicitly too so the retry route can return a clear "already applied"
 * response without even attempting a write, rather than relying solely on
 * the DB rejecting a duplicate insert.
 */
export function canRetryContractApplication(
  variationStatus: string,
  hasExistingLineItem: boolean
): boolean {
  return variationStatus === 'approved' && !hasExistingLineItem
}
