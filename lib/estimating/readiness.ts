// ─── Quote readiness — the one builder-facing trust signal ────────────────────
// Maps the quote's internal safety signals (unresolved assumptions, unpriced
// line items, QA risks, extraction confidence) into exactly three states a
// non-technical builder can act on:
//
//   blocked          — this quote's TOTAL IS WRONG (items missing answers or
//                      missing prices contribute $0). Sending is refused
//                      server-side, not just discouraged in the UI.
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
   * Unresolved conservative assumptions (assumptions.gate IS NULL) —
   * WorkA proceeded past a blocking clarifying question using a disclosed
   * default instead of stopping the pipeline (non-blocking estimation).
   * Deliberately a REVIEW reason, not a blocked one: unlike Gates 1-3
   * (unresolvedAssumptions above), a $ total genuinely exists here — the
   * estimate is complete, just built on a stated assumption worth a look,
   * not missing information the way an unpriced/no-unit item is.
   */
  unresolvedConservativeAssumptions: number
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
  if (signals.unresolvedConservativeAssumptions > 0) {
    reviewReasons.push(
      `WorkA assumed ${signals.unresolvedConservativeAssumptions} ${plural(signals.unresolvedConservativeAssumptions, 'thing')} it couldn't confirm from your documents — review before sending`
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
