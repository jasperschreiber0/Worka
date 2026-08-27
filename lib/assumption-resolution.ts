// Pure decision logic for POST /api/assumptions/[quoteId]/resolve's
// persistence-truthfulness fix (Round 4 reliability audit finding).
//
// Core invariant this module exists to enforce: the route must never reach a
// state where assumptions.resolution_type says an assumption was resolved
// while its linked quote_line_items row still represents the old/unresolved
// value. The route enforces this by ORDERING — the quote_line_items write
// happens first, and assumptions.resolution_type is only ever written once
// that succeeds (see shouldRecordAssumptionAsResolved) — not by attempting a
// real multi-table transaction (supabase-js has none available here) or by
// inventing a new "failed"/"pending" resolution_type value (the DB CHECK
// constraint on assumptions.resolution_type only allows
// 'accepted'|'adjusted'|'excluded' — a new value would need a migration,
// which this fix deliberately avoids per its own scope).

export type ResolutionType = 'accepted' | 'adjusted' | 'excluded'

export interface LineItemUpdatePayload {
  assumption_status: ResolutionType
  quantity?: number
  unit?: string
  total?: number
  is_assumption?: boolean
}

/**
 * Builds the quote_line_items update payload for a given resolution.
 * Extracted as a pure function so the exact fields written (and the total
 * computation) are unit-testable without a live database. Byte-identical
 * logic to the route's own inline version before this fix.
 */
export function buildLineItemUpdate(
  resolution: ResolutionType,
  params: { adjustedQuantity?: number; adjustedUnit?: string; priorRate: number | null }
): LineItemUpdatePayload {
  const update: LineItemUpdatePayload = { assumption_status: resolution }

  if (resolution === 'adjusted') {
    update.quantity = params.adjustedQuantity
    if (params.adjustedUnit !== undefined) {
      update.unit = params.adjustedUnit
    }
    if (params.priorRate !== null && params.adjustedQuantity !== undefined) {
      update.total = params.adjustedQuantity * params.priorRate
    }
  }

  if (resolution === 'excluded') {
    update.is_assumption = true
    update.assumption_status = 'excluded'
  }

  return update
}

export interface AssumptionResolutionState {
  resolution_type: string | null
}

/**
 * Whether every assumption on the quote is resolved (used to decide the
 * draft -> pending_review transition). Unchanged in meaning from the
 * route's original inline version — extracted only so "a partial-failure
 * state cannot advance to pending_review" is directly testable: an
 * assumption whose line-item write failed never gets its resolution_type
 * set (see shouldRecordAssumptionAsResolved), so it still reads as
 * unresolved here, by construction.
 */
export function allAssumptionsResolved(assumptions: AssumptionResolutionState[]): boolean {
  return (
    assumptions.length > 0 &&
    assumptions.every((a) => a.resolution_type !== null && a.resolution_type !== 'unresolved')
  )
}

export interface WriteAttempt {
  error: { message: string } | null
}

/**
 * The core gate: assumptions.resolution_type may only be written once the
 * linked quote_line_items write has been confirmed successful.
 * `lineItemWrite: null` means the assumption has no linked line item at all
 * (assumptions.line_item_id IS NULL) — nothing to wait on, so recording the
 * resolution is immediately safe, matching the route's pre-existing
 * behavior for that case.
 */
export function shouldRecordAssumptionAsResolved(lineItemWrite: WriteAttempt | null): boolean {
  if (lineItemWrite === null) return true
  return lineItemWrite.error === null
}

/**
 * Interprets the result of the guarded draft -> pending_review UPDATE
 * (`.eq('status','draft')`, so 0 rows matched means either a genuine write
 * failure OR the quote was already advanced by an earlier/concurrent
 * request — those two cases are NOT the same and must not be conflated.
 * `data` non-null means this call's UPDATE genuinely won the transition,
 * so its returned status is authoritative. Otherwise, the caller must
 * re-check the quote's real current status rather than assume success —
 * `currentActualStatus` is that re-checked value (or null if that read
 * itself failed, in which case 'draft' is the honest, conservative default
 * rather than claiming an unconfirmed 'pending_review').
 */
export function resolveQuoteStatusAfterTransitionAttempt(
  transitionResult: { data: { status: string } | null },
  currentActualStatus: string | null
): string {
  if (transitionResult.data) return transitionResult.data.status
  return currentActualStatus ?? 'draft'
}
