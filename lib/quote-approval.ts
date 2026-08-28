// ─── Client Quote Review & Approval — pure decision logic ──────────────────
// Round 13 creation milestone. Mirrors lib/variation-approval.ts's role:
// the one shared place the state-transition/eligibility rules live, so the
// public approve route and the client page can never drift apart, and so
// this logic is unit-testable without importing the route.ts file it backs
// (importing a route.ts pulls in next/server, which Node's ESM resolver
// cannot resolve outside Next's own bundler — see Round 12's own writeup).
//
// Relative, .ts-suffixed imports — must resolve identically under plain
// `node --experimental-strip-types` and under Next.js/webpack, same reason
// lib/pricing.ts's own import of trade-taxonomy.ts documents.
import { calculateClientPrice, type SellPriceableItem } from './pricing.ts'
import { tradeCategoryName } from './trade-taxonomy.ts'

export type QuoteStatus = 'draft' | 'pending_review' | 'sent' | 'approved' | 'rejected'

/**
 * A quote is approvable by a client only once it has actually been sent —
 * never draft/pending_review (not yet client-visible) and never
 * approved/rejected again (forward-only, replay-proof). This is the single
 * source of truth for that eligibility check; the public route's atomic
 * `UPDATE ... WHERE status = 'sent'` is the actual enforcement, but this
 * function is what both the route and the client page consult to decide
 * what to show/attempt without duplicating the rule.
 */
export function isQuoteApprovableByClient(status: QuoteStatus): boolean {
  return status === 'sent'
}

/**
 * A quote's financial detail is only shown to a client once it has been
 * sent, or once a decision has already been recorded — never while still
 * draft/pending_review, which may contain unresolved assumptions or
 * unpriced items never meant to reach a client.
 */
export function isQuoteViewableByClient(status: QuoteStatus): boolean {
  return status === 'sent' || status === 'approved' || status === 'rejected'
}

export type QuoteApprovalOutcome = 'approved' | 'rejected' | 'not_yet_decided'

/** What the client-facing page should render for a given (already-fetched) status. */
export function describeQuoteApprovalState(status: QuoteStatus): QuoteApprovalOutcome {
  if (status === 'approved') return 'approved'
  if (status === 'rejected') return 'rejected'
  return 'not_yet_decided'
}

// ─── Client-safe line item view ─────────────────────────────────────────────

export interface QuoteLineItemForClient {
  trade_category_id: number
  description: string
  total: number | null
  margin_pct: number | null
  assumption_status: string | null
}

export interface ClientVisibleLineItem {
  description: string
  client_price: number
}

export interface ClientVisibleCategory {
  trade_category_id: number
  trade_name: string
  items: ClientVisibleLineItem[]
  subtotal: number
}

export interface ClientVisibleQuote {
  categories: ClientVisibleCategory[]
  total: number
}

/**
 * Builds the ENTIRE client-facing view of a quote's line items — the only
 * function permitted to shape what a client sees. Deliberately narrow:
 * every returned item carries only `description` and its own marked-up
 * `client_price` (via calculateClientPrice, never total_cost/rate directly)
 * — never quantity, unit, rate, margin_pct, confidence, pricing_source, or
 * assumption_status. Excluded items (assumption_status === 'excluded')
 * never appear, matching calculateClientPrice's own definition of
 * "included" so the category/grand totals always agree with the sum of
 * what's actually shown.
 */
export function buildClientVisibleQuote(items: QuoteLineItemForClient[]): ClientVisibleQuote {
  const included = items.filter((i) => i.assumption_status !== 'excluded')

  const byTrade = new Map<number, QuoteLineItemForClient[]>()
  for (const item of included) {
    const arr = byTrade.get(item.trade_category_id) ?? []
    arr.push(item)
    byTrade.set(item.trade_category_id, arr)
  }

  const categories: ClientVisibleCategory[] = Array.from(byTrade.entries())
    .map(([tradeCategoryId, tradeItems]) => {
      const asSellPriceable: SellPriceableItem[] = tradeItems.map((i) => ({
        total: i.total,
        margin_pct: i.margin_pct,
        assumption_status: i.assumption_status,
      }))
      return {
        trade_category_id: tradeCategoryId,
        trade_name: tradeCategoryName(tradeCategoryId),
        items: tradeItems.map((i) => ({
          description: i.description,
          client_price: calculateClientPrice([{ total: i.total, margin_pct: i.margin_pct, assumption_status: i.assumption_status }]),
        })),
        subtotal: calculateClientPrice(asSellPriceable),
      }
    })
    .sort((a, b) => a.trade_category_id - b.trade_category_id)

  const total = calculateClientPrice(
    included.map((i) => ({ total: i.total, margin_pct: i.margin_pct, assumption_status: i.assumption_status }))
  )

  return { categories, total }
}
