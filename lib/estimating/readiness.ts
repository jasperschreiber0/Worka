// ─── Quote readiness — the one builder-facing trust signal ────────────────────
// Maps the quote's internal safety signals (unresolved assumptions, unpriced
// line items, QA risks, extraction confidence) into exactly three states a
// non-technical builder can act on:
//
//   blocked          — this quote is not safe to send: items missing answers
//                      or missing prices contribute $0, a whole scoped trade
//                      has no line items yet, or WorkA proceeded past an
//                      unanswered blocking clarifying question using an
//                      unconfirmed default. Sending is refused server-side
//                      (getSendBlockingReasons below), not just discouraged
//                      in the UI.
//   review_required  — the number is complete but WorkA found things worth a
//                      human look before it goes to a client (QA risks,
//                      document conflicts, low-confidence extractions).
//                      Sending is allowed; the risks are shown, not hidden.
//   ready            — nothing outstanding.
//
// This exists because the previous gate ("all assumptions resolved") only
// covered quantity/unit gaps (Gates 1-3). A line item that failed all five
// pricing tiers had rate = null, contributed $0 to the total, was NOT an
// assumption, and sailed through to 'sent' looking complete — a quote that
// silently under-quotes real scope. That must never present as sendable.
//
// Pure function — shared by the quote GET API (which derives it server-side)
// and unit-tested without a database.

import type { SupabaseClient } from '@supabase/supabase-js'

export type QuoteReadiness = 'ready' | 'review_required' | 'blocked'

// Below this extraction-confidence score the quote drops to review_required
// even with no other findings — mirrors the <50 threshold runQualityAssurance
// already uses for its per-line low-confidence risk.
export const LOW_CONFIDENCE_REVIEW_THRESHOLD = 50

export interface ReadinessSignals {
  /** Assumption rows still unresolved (Gates 1-3 — quantity/unit gaps). */
  unresolvedAssumptions: number
  /**
   * Included (non-excluded) line items whose total is null and that are NOT
   * already surfaced as an unresolved assumption — i.e. the silent ones: a
   * real scope item that failed every pricing tier and currently adds $0 to
   * the quote with nothing else flagging it.
   */
  unpricedItems: number
  /** qa_report.top_risks length (missing trades, low-confidence lines, ...). */
  topRiskCount: number
  /** qa_report.review_items length (duplicates, conflicts, sanity checks). */
  reviewItemCount: number
  /** quotes.confidence_score — lowest included line-item confidence. */
  confidenceScore: number | null
  /**
   * Unresolved conservative assumptions (assumptions.gate IS NULL) — WorkA
   * proceeded past a blocking clarifying question using a disclosed default
   * instead of stopping the pipeline (non-blocking estimation). Promoted to
   * a BLOCKED reason (Estimate Completeness & Confidence Integrity Audit,
   * P0-1): the pipeline's own "blocking" label exists specifically for
   * questions it judges the estimate cannot proceed responsibly without —
   * treating that as merely worth a look, not a hard stop, let a
   * structurally under-specified estimate (the audit's own example: a
   * double-storey addition with no structural drawings) look fully priced
   * and sendable. A $ total existing doesn't mean the total is trustworthy
   * when it rests on an unconfirmed default for exactly the question WorkA
   * itself flagged as highest-severity.
   */
  unresolvedConservativeAssumptions: number
  /**
   * Scoped trades (Stage 3) with zero generated line items (qa_report.
   * missing_trade_details) — including any that Stage 6's own completeness
   * recovery attempted and still could not fill. Promoted to a BLOCKED
   * reason for the same reason as unresolvedConservativeAssumptions above
   * (audit P0-2): an entirely absent trade is invisible to unpricedItems
   * (there is no line item for that check to even see), so without this a
   * quote missing a whole trade could look completely priced and sendable.
   */
  missingTradeCount: number
}

export interface ReadinessResult {
  readiness: QuoteReadiness
  /** Builder-readable reasons the quote cannot be sent yet. Empty unless blocked. */
  blockedReasons: string[]
  /** Builder-readable reasons to review before sending. Empty when ready. */
  reviewReasons: string[]
}

function plural(n: number, singular: string, pluralWord?: string): string {
  return n === 1 ? singular : (pluralWord ?? `${singular}s`)
}

export function deriveQuoteReadiness(signals: ReadinessSignals): ReadinessResult {
  const blockedReasons: string[] = []
  const reviewReasons: string[] = []

  if (signals.unresolvedAssumptions > 0) {
    blockedReasons.push(
      `${signals.unresolvedAssumptions} ${plural(signals.unresolvedAssumptions, 'item needs', 'items need')} an answer from you before the quote is complete`
    )
  }
  if (signals.unpricedItems > 0) {
    blockedReasons.push(
      `${signals.unpricedItems} ${plural(signals.unpricedItems, 'item has', 'items have')} no price and currently ${plural(signals.unpricedItems, 'adds', 'add')} $0 to the total — set a rate or exclude ${plural(signals.unpricedItems, 'it', 'them')}`
    )
  }
  if (signals.missingTradeCount > 0) {
    blockedReasons.push(
      `${signals.missingTradeCount} scoped ${plural(signals.missingTradeCount, 'trade has', 'trades have')} no line items yet — review before sending`
    )
  }
  if (signals.unresolvedConservativeAssumptions > 0) {
    blockedReasons.push(
      `WorkA assumed ${signals.unresolvedConservativeAssumptions} ${plural(signals.unresolvedConservativeAssumptions, 'thing')} it couldn't confirm from your documents (an unanswered blocking question) — confirm before sending`
    )
  }

  if (signals.topRiskCount > 0) {
    reviewReasons.push(
      `WorkA flagged ${signals.topRiskCount} ${plural(signals.topRiskCount, 'risk')} worth checking`
    )
  }
  if (signals.reviewItemCount > 0) {
    reviewReasons.push(
      `${signals.reviewItemCount} ${plural(signals.reviewItemCount, 'thing', 'things')} to double-check before sending`
    )
  }
  if (signals.confidenceScore !== null && signals.confidenceScore < LOW_CONFIDENCE_REVIEW_THRESHOLD) {
    reviewReasons.push(
      `Some quantities were read with low confidence (${signals.confidenceScore}%) — check the red-marked lines`
    )
  }
  if (blockedReasons.length > 0) {
    return { readiness: 'blocked', blockedReasons, reviewReasons }
  }
  if (reviewReasons.length > 0) {
    return { readiness: 'review_required', blockedReasons: [], reviewReasons }
  }
  return { readiness: 'ready', blockedReasons: [], reviewReasons: [] }
}

/**
 * The one shared definition of "silently unpriced": included in the quote,
 * contributes nothing to the total, and not already surfaced through the
 * assumption-resolution flow. Used identically by the quote GET (readiness),
 * the send draft route, and confirm-send's final server-side guard — so the
 * UI's blocked state and the server's refusal can never disagree.
 */
export function isSilentlyUnpriced(item: {
  total: number | null
  assumption_status: string | null
  is_assumption?: boolean | null
}): boolean {
  if (item.assumption_status === 'excluded') return false
  if (item.total !== null) return false
  // An unresolved assumption is already blocked/surfaced by the assumption
  // flow — counting it here too would double-report the same line.
  if (item.is_assumption && item.assumption_status === 'unresolved') return false
  return true
}

// ─── The send gate — the one shared source of truth for "can this quote go
// out" ──────────────────────────────────────────────────────────────────────
// readiness.ts / deriveQuoteReadiness above feeds the quote GET response's
// display state (can_send, blocked_reasons) — it does NOT, by itself, stop
// an email from being sent. The actual enforcement is this function, called
// identically by the send-draft route and confirm-send's final server-side
// guard, so a quote that display says is blocked and a quote the server
// will actually refuse to send can never disagree (Estimate Completeness &
// Confidence Integrity Audit: "detection exists, enforcement does not" —
// this closes that gap for the three signals below). Returns an empty array
// when the quote is safe to send.

export interface SendBlockingLineItem {
  description: string
  total: number | null
  assumption_status: string | null
  is_assumption?: boolean | null
}

export interface SendBlockingMissingTrade {
  trade_name: string
}

// ─── Shared conservative-assumption fetch ──────────────────────────────────
// The exact `assumptions WHERE quote_id = ? AND gate IS NULL AND
// line_item_id IS NULL AND resolution_type IS NULL` query was hand-written
// identically at four call sites (quotes GET, send, confirm-send, revise) —
// one shared function so the definition of "unresolved conservative
// assumption" can't drift between the routes that read it and the routes
// that enforce on it.
export async function getUnresolvedConservativeAssumptions(
  supabase: SupabaseClient,
  quoteId: string,
  // Callers that only need a count (send, confirm-send) use the cheap
  // default; revise/route.ts passes '*' since it copies the full rows
  // forward onto the new quote version.
  columns: string = 'id'
) {
  return supabase
    .from('assumptions')
    .select(columns)
    .eq('quote_id', quoteId)
    .is('gate', null)
    .is('line_item_id', null)
    .is('resolution_type', null)
}

export function getSendBlockingReasons(input: {
  lineItems: SendBlockingLineItem[]
  missingTrades: SendBlockingMissingTrade[]
  unresolvedConservativeAssumptionCount: number
}): string[] {
  const reasons: string[] = []

  const unpriced = input.lineItems.filter((li) => isSilentlyUnpriced(li))
  if (unpriced.length > 0) {
    const names = unpriced.slice(0, 3).map((li) => `"${li.description}"`).join(', ')
    reasons.push(
      `${unpriced.length} item${unpriced.length !== 1 ? 's' : ''} (${names}${unpriced.length > 3 ? ', …' : ''}) have no price and currently add $0 to this quote. Set a rate or exclude them before sending.`
    )
  }

  if (input.missingTrades.length > 0) {
    const names = input.missingTrades.map((t) => t.trade_name).join(', ')
    reasons.push(
      `${input.missingTrades.length} scoped trade${input.missingTrades.length !== 1 ? 's' : ''} (${names}) ${input.missingTrades.length !== 1 ? 'have' : 'has'} no line items generated yet. Review before sending.`
    )
  }

  if (input.unresolvedConservativeAssumptionCount > 0) {
    reasons.push(
      `WorkA assumed ${input.unresolvedConservativeAssumptionCount} thing${input.unresolvedConservativeAssumptionCount !== 1 ? 's' : ''} it couldn't confirm from your documents (an unanswered blocking question). Review and confirm before sending.`
    )
  }

  return reasons
}
