// ─── Stage 8: Quality Assurance ────────────────────────────────────────────────
// Runs once, Next.js-side, immediately after pricing resolves rates and totals
// (lib/pricing.ts ensureQuotePriced) and before the estimate is rendered to the
// builder. Never throws — a QA failure must not block the quote being shown.

import type { SupabaseClient } from '@supabase/supabase-js'
// Relative, not the '@/*' alias used elsewhere in this route/module —
// needed so this file resolves identically under plain
// `node --experimental-strip-types` (the dev scripts now call
// runQualityAssurance directly, for parity with production) and under
// Next.js/webpack. Same reasoning lib/pricing.ts's own imports document.
import { TRADE_CATEGORIES } from '../trade-taxonomy.ts'
import type { QAReport } from '../types/database.types.ts'
import { pairSupersededFacts, type FactRow } from '../../supabase/functions/smooth-responder/pipeline-logic.ts'
import { isSilentlyUnpriced } from './readiness.ts'
import { applyMargin, calculateClientPrice } from '../pricing.ts'

const UNIT_SANITY_MAX: Record<string, number> = {
  m2: 2000,
  m3: 500,
  lm: 2000,
  each: 500,
  weeks: 104,
  hours: 2000,
}

interface QALineItem {
  id: string
  trade_category_id: number
  description: string
  quantity: number | null
  unit: string | null
  rate: number | null
  total: number | null
  confidence: number | null
  is_assumption: boolean | null
  assumption_status: string | null
  margin_pct: number | null
}

export async function runQualityAssurance(
  supabase: SupabaseClient,
  quoteId: string,
  jobId: string
): Promise<QAReport | null> {
  try {
    const { data: items } = await supabase
      .from('quote_line_items')
      .select('id, trade_category_id, description, quantity, unit, rate, total, confidence, is_assumption, assumption_status, margin_pct')
      .eq('quote_id', quoteId)

    const lineItems = (items ?? []) as QALineItem[]
    const included = lineItems.filter((i) => i.assumption_status !== 'excluded')

    const topRisks: string[] = []
    const reviewItems: string[] = []
    const recommendedActions: string[] = []

    // ── Missing trades: scope reasoning said a trade is in scope, but no
    // line items ever landed for it — the completeness safeguard. Confirmed
    // on a real quote: External Cladding was scoped by Stage 3 (9 included
    // items) but Stage 6 generated zero line items for it, with nothing
    // downstream ever surfacing that gap because this check existed but was
    // never exercised against real generated output. Every scoped trade must
    // either produce line items or be explicitly explained here — never
    // silently absent. Now carries the actual expected scope text, not just
    // the trade name, so "what was missed" is answerable without a DB query.
    const missingTrades: number[] = []
    const missingTradeDetails: Array<{ trade_category_id: number; trade_name: string; expected_scope: string[] }> = []
    const { data: scopeRows } = await supabase
      .from('scope_items')
      .select('trade_category_id, included_scope')
      .eq('job_id', jobId)

    if (scopeRows) {
      const tradesWithItems = new Set(included.map((i) => i.trade_category_id))
      for (const row of scopeRows as Array<{ trade_category_id: number; included_scope: string[] }>) {
        if (row.included_scope?.length > 0 && !tradesWithItems.has(row.trade_category_id)) {
          missingTrades.push(row.trade_category_id)
          missingTradeDetails.push({
            trade_category_id: row.trade_category_id,
            trade_name: TRADE_CATEGORIES.find((t) => t.id === row.trade_category_id)?.name ?? `Trade ${row.trade_category_id}`,
            expected_scope: row.included_scope,
          })
        }
      }
    }
    if (missingTradeDetails.length > 0) {
      for (const d of missingTradeDetails) {
        const sample = d.expected_scope.slice(0, 3).join('; ')
        const more = d.expected_scope.length > 3 ? ` (+${d.expected_scope.length - 3} more)` : ''
        topRisks.push(`${d.trade_name} was identified as in-scope but has NO priced line items. Expected scope included: ${sample}${more}.`)
      }
      const names = missingTradeDetails.map((d) => d.trade_name)
      recommendedActions.push(`Review ${names.join(', ')} — scope reasoning expected line items here and none were generated. This is a generation gap, not a missing-scope gap.`)
    }

    // ── Duplicate descriptions within the same trade ──
    const seen = new Map<string, number>()
    for (const item of included) {
      const key = `${item.trade_category_id}::${item.description.trim().toLowerCase()}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    const duplicateDescriptions = Array.from(seen.entries())
      .filter(([, count]) => count > 1)
      .map(([key]) => key.split('::')[1])
    if (duplicateDescriptions.length > 0) {
      reviewItems.push(`${duplicateDescriptions.length} duplicated line item description${duplicateDescriptions.length !== 1 ? 's' : ''} in the same trade.`)
    }

    // ── Unrealistic quantities ──
    let unrealisticCount = 0
    for (const item of included) {
      if (item.quantity === null || !item.unit) continue
      const max = UNIT_SANITY_MAX[item.unit]
      if (max && item.quantity > max) unrealisticCount++
    }
    if (unrealisticCount > 0) {
      reviewItems.push(`${unrealisticCount} line item${unrealisticCount !== 1 ? 's have' : ' has'} an unusually large quantity for its unit — worth a sanity check.`)
    }

    // ── Unpriced items — a TOP risk, not a footnote ──
    // A line that failed every pricing tier has total = null and contributes
    // $0 to the quote while still describing real scope. This is the single
    // most direct way WorkA could cost a builder money, so it's named per
    // item (not just counted) and lands in top_risks. The quote GET derives
    // its blocked state from the same isSilentlyUnpriced definition, so this
    // warning and the send gate can never disagree.
    const unpriced = included.filter((i) => isSilentlyUnpriced(i))
    if (unpriced.length > 0) {
      const names = unpriced.slice(0, 5).map((i) => `"${i.description}"`).join(', ')
      const more = unpriced.length > 5 ? ` and ${unpriced.length - 5} more` : ''
      topRisks.push(`${unpriced.length} item${unpriced.length !== 1 ? 's have' : ' has'} no price and currently add${unpriced.length === 1 ? 's' : ''} $0 to this quote: ${names}${more}.`)
      recommendedActions.push('Set a rate for the unpriced items (or exclude them) — the total is understated until you do.')
    }
    const lowConfidence = included.filter((i) => (i.confidence ?? 100) < 50)
    if (lowConfidence.length > 0) {
      topRisks.push(`${lowConfidence.length} line item${lowConfidence.length !== 1 ? 's are' : ' is'} below 50% confidence.`)
      recommendedActions.push('Review low-confidence line items before sending this quote to the client.')
    }

    // ── Missing documentation ──
    const { count: docCount } = await supabase
      .from('project_documents')
      .select('id', { count: 'exact', head: true })
      .eq('job_id', jobId)
    if (!docCount || docCount === 0) {
      reviewItems.push('No source documents on record for this estimate — quantities came from a plain-English description.')
    }

    // ── Document conflicts — surfaced, never silently merged ──
    // When two documents state different values for the same fact (plan says
    // kitchen island 2400mm, spec says 3000mm), the engine already supersedes
    // the older fact deterministically at write time (mergeFacts) — but until
    // now that resolution was invisible: the builder never learned a conflict
    // existed, let alone which value won. pairSupersededFacts (the same
    // shared pairing chat's project memory uses — exact category+key match
    // plus the same semantic-similarity check mergeFacts applied at write
    // time) reconstructs old-value → current-value pairs so the builder can
    // confirm the value WorkA chose. created_at DESC on the superseded query
    // is a hard precondition of that function, not a preference.
    try {
      const [{ data: activeFacts }, { data: supersededFacts }] = await Promise.all([
        supabase
          .from('project_facts')
          .select('category, key, value, embedding')
          .eq('job_id', jobId)
          .eq('superseded', false)
          .order('confidence', { ascending: false })
          .limit(200),
        supabase
          .from('project_facts')
          .select('category, key, value, embedding')
          .eq('job_id', jobId)
          .eq('superseded', true)
          .order('created_at', { ascending: false })
          .limit(50),
      ])
      if (activeFacts && supersededFacts && supersededFacts.length > 0) {
        const conflicts = pairSupersededFacts(activeFacts as FactRow[], supersededFacts as FactRow[], undefined, 5)
        for (const c of conflicts) {
          reviewItems.push(
            `Your documents disagreed on ${c.key.replace(/_/g, ' ')}: one said "${c.oldValue}", another said "${c.newValue}". WorkA is using "${c.newValue}" — confirm that's the right one.`
          )
        }
        if (conflicts.length > 0) {
          recommendedActions.push('Check the document disagreements listed — WorkA kept the most recent value, but only you know which document is current.')
        }
      }
    } catch (conflictErr) {
      // Conflict surfacing is additive — its failure must never take down QA.
      console.error('runQualityAssurance: conflict pairing failed', conflictErr)
    }

    const { data: quote } = await supabase
      .from('quotes')
      .select('confidence_score, document_contribution, price_coverage_pct, pricing_match_rate_pct, allowance_pct, trade_recovery_report, total_cost, margin_pct')
      .eq('id', quoteId)
      .single()

    const overallConfidence = quote?.confidence_score ?? null
    const priceCoveragePct = quote?.price_coverage_pct ?? null
    const pricingMatchRatePct = quote?.pricing_match_rate_pct ?? null
    const allowancePct = quote?.allowance_pct ?? null
    // Migration 074 — smooth-responder's own before/after record of its
    // Stage 6 completeness recovery pass, distinct from missing_trade_details
    // below (which is always freshly re-derived against final state, so it
    // naturally shows any trade recovery failed to fix — a useful
    // cross-check, not a duplicate of this field).
    const tradeRecovery = (quote?.trade_recovery_report ?? null) as QAReport['trade_recovery']
    if (tradeRecovery && tradeRecovery.recovered_trades.length > 0) {
      const names = tradeRecovery.recovered_trades
        .map((r) => `${TRADE_CATEGORIES.find((t) => t.id === r.trade_category_id)?.name ?? `Trade ${r.trade_category_id}`} (${r.items_generated} item${r.items_generated === 1 ? '' : 's'})`)
        .join(', ')
      reviewItems.push(`Completeness recovery generated missing line items for: ${names} — these were scoped but not produced by the initial estimate pass.`)
    }
    if (tradeRecovery && tradeRecovery.remaining_missing_trades.length > 0) {
      // Prefer the recorded failure_reason (migration 074's max_tokens
      // retry fix) so "still missing" comes with a concrete cause — e.g.
      // "truncated at 8000 tokens, retry at 24000 also failed" — rather
      // than a bare trade name with nothing to act on.
      const failuresByTrade = new Map((tradeRecovery.failures ?? []).map((f) => [f.trade_category_id, f]))
      const details = tradeRecovery.remaining_missing_trades.map((id) => {
        const name = TRADE_CATEGORIES.find((t) => t.id === id)?.name ?? `Trade ${id}`
        const failure = failuresByTrade.get(id)
        return failure?.failure_reason ? `${name} (${failure.failure_reason})` : name
      })
      topRisks.push(`Completeness recovery could not generate line items for: ${details.join(', ')} — still missing after a targeted retry.`)
    }

    // ── Financial reconciliation — the canonical client price (sum of each
    // line item's OWN margin_pct) must never diverge from what the old
    // blanket total_cost * quote.margin_pct formula would have produced.
    // That blanket formula is what every client-facing surface used to call
    // independently (quote summary API, PDF export, invoice schedule) before
    // this was unified — comparing against it here is a live regression
    // detector: if anything ever bypasses calculateClientPrice again (a new
    // call site, a reverted fix), this is what catches it before a quote
    // goes out, not after a builder notices the numbers don't match.
    // High severity: pushed first among financial checks, and — unlike
    // price coverage/pricing match rate below — never conditional on a
    // threshold, since ANY divergence beyond rounding means two different
    // dollar figures exist for the same quote.
    if (quote?.total_cost !== null && quote?.total_cost !== undefined && quote?.margin_pct !== null && quote?.margin_pct !== undefined) {
      const canonicalClientPrice = calculateClientPrice(included)
      const legacyBlanketClientPrice = applyMargin(quote.total_cost, quote.margin_pct)
      const reconciliationDrift = Math.round(Math.abs(canonicalClientPrice - legacyBlanketClientPrice) * 100) / 100
      if (reconciliationDrift > 1) {
        // unshift, not push: this is the highest-severity financial check in
        // the report and must survive `topRisks.slice(0, 5)` below even when
        // several other lower-stakes risks were already queued ahead of it.
        topRisks.unshift(
          `FINANCIAL_RECONCILIATION_FAILED — the sum of line-item sell prices ($${canonicalClientPrice.toLocaleString('en-AU')}) does not match total_cost marked up by the quote's blanket margin ($${legacyBlanketClientPrice.toLocaleString('en-AU')}), a difference of $${reconciliationDrift.toLocaleString('en-AU')}. This usually means provisional-sum items (0% margin) or a per-item margin different from the quote's blanket rate are present — the line-item total is the correct one; do not treat the blanket figure as authoritative.`
        )
        recommendedActions.unshift('Do not send this quote until the financial reconciliation discrepancy above is understood — the client-facing total must come from each line item\'s own margin, never a blanket quote-level rate.')
      }
    }

    // ── Price coverage — a top risk, not a footnote, below 90% ──
    // ensureQuotePriced/recomputeQuoteTotals (lib/pricing.ts) already
    // computed and persisted this by the time QA runs; surfacing it here
    // puts it in front of the builder alongside the other review signals
    // instead of only existing as a column nobody's shown.
    if (priceCoveragePct !== null && priceCoveragePct < 90) {
      topRisks.push(`Only ${priceCoveragePct}% of line items have a price — the total reflects that partial coverage, not the full scope.`)
      recommendedActions.push('Review unpriced and allowance line items before treating this total as final.')
    }

    // ── Pricing match rate — a distinct signal from coverage (migration
    // 072): coverage answers "does every line have a number," this answers
    // "how many of those numbers came from an actual matched rate" rather
    // than a category average, an AI estimate, or an allowance. A quote can
    // have 100% coverage and a low match rate — that combination is exactly
    // the case a builder most needs flagged, since it looks complete but
    // rests mostly on judgment calls.
    if (pricingMatchRatePct !== null && pricingMatchRatePct < 50) {
      reviewItems.push(`Only ${pricingMatchRatePct}% of priced line items came from a confirmed rate match — the rest are category averages, AI estimates, or allowances. Worth a closer read before relying on individual line prices.`)
    }

    // Per-source-tier counts — the observability this migration asks for:
    // how many items landed at each rung of the fallback chain, not just
    // the two aggregate percentages above.
    const { data: sourceRows } = await supabase
      .from('quote_line_items')
      .select('pricing_source, assumption_status, total')
      .eq('quote_id', quoteId)
    const pricingTierBreakdown: Record<string, number> = {}
    let allowanceCount = 0
    let allowanceValue = 0
    for (const row of (sourceRows ?? []) as Array<{ pricing_source: string | null; assumption_status: string | null; total: number | null }>) {
      if (row.assumption_status === 'excluded') continue
      const key = row.pricing_source ?? 'not_yet_priced'
      pricingTierBreakdown[key] = (pricingTierBreakdown[key] ?? 0) + 1
      if (row.pricing_source === 'ai_allowance') {
        allowanceCount++
        allowanceValue += row.total ?? 0
      }
    }
    allowanceValue = Math.round(allowanceValue * 100) / 100

    // ── Allowance dollar dominance — groundwork for allowance quality
    // signals (not builder learning yet, see the pricing_source audit this
    // migration is part of). Sits alongside price_coverage_pct/
    // pricing_match_rate_pct: a quote can be fully covered and mostly
    // rate-matched by ITEM COUNT while still being dominated, in dollars,
    // by a handful of large allowances — confirmed on the real project this
    // was built against, where Preliminaries (the largest trade by $) is
    // almost entirely large ai_allowance figures (pool, lift, structural
    // engineer, landscaping).
    if (allowancePct !== null && allowancePct >= 50) {
      reviewItems.push(`${allowancePct}% of this estimate's value comes from AI allowances (${allowanceCount} item${allowanceCount === 1 ? '' : 's'}, $${allowanceValue.toLocaleString('en-AU')}) rather than measured quantities or rate matches — treat the total as a considered estimate, not a firm price.`)
    }

    // ── Documents that contributed nothing ──
    // The engine's contribution report (migration 039) records, per source
    // document, how many facts it yielded and how many reached the estimate
    // prompt. With balanced selection a processed document can only end up
    // at zero USED facts if it yielded zero facts at all — which means its
    // scope is simply not in this estimate. The builder must hear that from
    // WorkA, not discover it on site.
    const contribution = quote?.document_contribution as {
      documents?: Array<{ name: string; facts_extracted: number; facts_used: number }>
      excluded?: string[]
      failed?: string[]
    } | null
    if (contribution) {
      const silentDocs = (contribution.documents ?? []).filter((d) => d.facts_used === 0)
      for (const d of silentDocs.slice(0, 5)) {
        topRisks.push(`Nothing usable could be read from "${d.name}" — whatever it covers is NOT in this estimate. Check that document's scope by hand.`)
      }
      const notProcessed = [...(contribution.excluded ?? []), ...(contribution.failed ?? [])]
      if (notProcessed.length > 0) {
        topRisks.push(`${notProcessed.length} document${notProcessed.length !== 1 ? 's were' : ' was'} not processed at all: ${notProcessed.slice(0, 5).join(', ')}${notProcessed.length > 5 ? ', …' : ''}. Their scope is missing from this estimate.`)
      }
      if (silentDocs.length > 0 || notProcessed.length > 0) {
        recommendedActions.push('Review the "What WorkA read" panel — some documents did not influence this estimate.')
      }
    }

    if (recommendedActions.length === 0) {
      recommendedActions.push('No material risks detected — this estimate is ready for review.')
    }

    const report: QAReport = {
      top_risks: topRisks.slice(0, 5),
      review_items: reviewItems.slice(0, 10),
      recommended_actions: recommendedActions.slice(0, 5),
      missing_trades: missingTrades,
      missing_trade_details: missingTradeDetails,
      duplicate_descriptions: duplicateDescriptions.slice(0, 10),
      price_coverage_pct: priceCoveragePct,
      pricing_match_rate_pct: pricingMatchRatePct,
      pricing_tier_breakdown: pricingTierBreakdown,
      allowance_pct: allowancePct,
      allowance_count: allowanceCount,
      allowance_value: allowanceValue,
      trade_recovery: tradeRecovery,
    }

    await supabase
      .from('quotes')
      .update({ qa_report: report, overall_confidence: overallConfidence })
      .eq('id', quoteId)

    return report
  } catch (err) {
    console.error('runQualityAssurance failed:', err)
    return null
  }
}
