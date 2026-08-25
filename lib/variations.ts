// ─── Variations v1 — Connect Contract & Margin ──────────────────────────────
//
// The one thing this module does: turn an APPROVED variation into a real
// quote_line_items row, so the existing, canonical calculateClientPrice()
// (lib/pricing.ts) — the same function every other client-facing price
// already goes through — naturally includes it. No parallel financial
// calculation is introduced here; this only ever produces a row in the same
// table manual and AI-extracted line items already live in.
//
// Called from both approval paths (the builder-side resolve route and the
// client-portal PATCH route) immediately after each one's own atomic,
// forward-only status update succeeds — so this function only ever runs
// once per variation that is genuinely transitioning to approved, not on a
// no-op retry (a retry's own status update finds the row no longer in
// draft/pending and never reaches this function at all). The
// quote_line_items_variation_id_unique partial unique index (migration 098)
// is the durable, DB-enforced backstop on top of that — not the only line
// of defense.

import type { SupabaseClient } from '@supabase/supabase-js'
// Relative, .ts-suffixed import — same reason pricing.test.ts/qa.ts document:
// this file (via variations.test.ts) must resolve identically under plain
// `node --experimental-strip-types` and under Next.js/webpack.
import { recomputeQuoteTotals } from './pricing.ts'

export interface ApprovedVariation {
  id: string
  job_id: string
  title: string
  amount: number
  trade_category_id: number | null
}

export interface VariationLineItemInsert {
  quote_id: string
  variation_id: string
  trade_category_id: number
  description: string
  quantity: null
  unit: null
  rate: null
  total: number
  margin_pct: number
  confidence: number
  is_assumption: boolean
  assumption_status: null
  pricing_source: 'variation'
  pricing_basis: null
  predicted_by: 'human'
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Pure — the exact quote_line_items row an approved variation becomes.
 * Prefixed description ("Variation: ...") so it's immediately recognisable
 * in QuoteView, not a mystery line. margin_pct 0 + quantity/unit/rate null:
 * variation.amount is already the client-facing figure (form label: "AUD,
 * inc. GST" — see this module's own note below on the GST question this
 * does NOT resolve), so it passes straight through calculateClientPrice()
 * unmarked-up, the same shape an existing PC/PS allowance line already
 * uses. Throws if trade_category_id is null — callers must check first
 * (applyApprovedVariationToQuote does, and returns a clear reason instead
 * of ever calling this in that state).
 *
 * GST note (traced, not assumed, deliberately not "fixed" here): every
 * other client-facing price in WorkA (QuoteView, PDF export, send-quote
 * email, job-activation contract value) is GST-EXCLUSIVE by explicit,
 * documented product decision (lib/pricing.ts's own PRICE_BASIS_LABEL
 * comment — GST is never auto-applied anywhere in this codebase's pricing
 * arithmetic). AddVariationDrawer's "Amount (AUD, inc. GST)" field label
 * is inconsistent with that decision. Inventing a GST-stripping conversion
 * here would be new financial arithmetic this milestone was explicitly
 * told not to add, and would silently assume every past variation amount
 * actually included GST as typed — an assumption this module has no way to
 * verify. variation.amount is passed through unchanged, on the same basis
 * as every other line item. The label mismatch is a separate, small,
 * pre-existing copy issue to fix later — not a financial calculation bug
 * introduced by this change.
 */
export function buildVariationLineItemInsert(
  variation: ApprovedVariation,
  quoteId: string
): VariationLineItemInsert {
  if (variation.trade_category_id === null) {
    throw new Error('buildVariationLineItemInsert: variation has no trade_category_id')
  }
  return {
    quote_id: quoteId,
    variation_id: variation.id,
    trade_category_id: variation.trade_category_id,
    description: `Variation: ${variation.title}`,
    quantity: null,
    unit: null,
    rate: null,
    total: round2(variation.amount),
    margin_pct: 0,
    confidence: 100,
    is_assumption: false,
    assumption_status: null,
    pricing_source: 'variation',
    pricing_basis: null,
    predicted_by: 'human',
  }
}

export type ApplyVariationResult =
  | { applied: true; alreadyApplied: boolean; lineItemId: string }
  | { applied: false; reason: string }

/**
 * Best-effort by design at the OUTER level (never throws — a failure here
 * must never undo the approval decision that already committed), but the
 * insert itself is a real, checked DB write, not fire-and-forget: callers
 * get back exactly what happened so they can surface it, rather than a
 * silent no-op.
 */
export async function applyApprovedVariationToQuote(
  supabase: SupabaseClient,
  variation: ApprovedVariation
): Promise<ApplyVariationResult> {
  try {
    if (variation.trade_category_id === null) {
      return {
        applied: false,
        reason: 'This variation has no trade category set — add one before it can update the contract.',
      }
    }

    // Same "current draft/pending_review quote for this job" lookup the
    // manual-estimate-creation and smooth-responder quote-creation paths
    // already use — reused, not reinvented.
    const { data: quote } = await supabase
      .from('quotes')
      .select('id')
      .eq('job_id', variation.job_id)
      .in('status', ['draft', 'pending_review'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!quote) {
      return { applied: false, reason: 'This job has no active estimate to apply the variation to.' }
    }

    const insertPayload = buildVariationLineItemInsert(variation, quote.id)

    const { data: inserted, error: insertErr } = await supabase
      .from('quote_line_items')
      .insert(insertPayload)
      .select('id')
      .single()

    if (insertErr) {
      // quote_line_items_variation_id_unique (migration 098) — this
      // variation already has a line item. Idempotent: find and return the
      // existing row instead of treating a retry/second-caller as a failure.
      if ((insertErr as { code?: string }).code === '23505') {
        const { data: existingLine } = await supabase
          .from('quote_line_items')
          .select('id')
          .eq('variation_id', variation.id)
          .maybeSingle()
        if (existingLine) {
          return { applied: true, alreadyApplied: true, lineItemId: existingLine.id }
        }
      }
      return { applied: false, reason: insertErr.message }
    }

    await recomputeQuoteTotals(supabase, quote.id)

    return { applied: true, alreadyApplied: false, lineItemId: inserted!.id }
  } catch (err) {
    return { applied: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
