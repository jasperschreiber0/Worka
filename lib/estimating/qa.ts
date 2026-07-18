// ─── Stage 8: Quality Assurance ────────────────────────────────────────────────
// Runs once, Next.js-side, immediately after pricing resolves rates and totals
// (lib/pricing.ts ensureQuotePriced) and before the estimate is rendered to the
// builder. Never throws — a QA failure must not block the quote being shown.

import type { SupabaseClient } from '@supabase/supabase-js'
import { TRADE_CATEGORIES } from '@/lib/trade-taxonomy'
import type { QAReport } from '@/lib/types/database.types'
import { pairSupersededFacts, type FactRow } from '@/supabase/functions/smooth-responder/pipeline-logic'
import { isSilentlyUnpriced } from '@/lib/estimating/readiness'

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
}

export async function runQualityAssurance(
  supabase: SupabaseClient,
  quoteId: string,
  jobId: string
): Promise<QAReport | null> {
  try {
    const { data: items } = await supabase
      .from('quote_line_items')
      .select('id, trade_category_id, description, quantity, unit, rate, total, confidence, is_assumption, assumption_status')
      .eq('quote_id', quoteId)

    const lineItems = (items ?? []) as QALineItem[]
    const included = lineItems.filter((i) => i.assumption_status !== 'excluded')

    const topRisks: string[] = []
    const reviewItems: string[] = []
    const recommendedActions: string[] = []

    // ── Missing trades: scope reasoning said a trade is in scope, but no
    // line items ever landed for it ──
    const missingTrades: number[] = []
    const { data: scopeRows } = await supabase
      .from('scope_items')
      .select('trade_category_id, included_scope')
      .eq('job_id', jobId)

    if (scopeRows) {
      const tradesWithItems = new Set(included.map((i) => i.trade_category_id))
      for (const row of scopeRows as Array<{ trade_category_id: number; included_scope: string[] }>) {
        if (row.included_scope?.length > 0 && !tradesWithItems.has(row.trade_category_id)) {
          missingTrades.push(row.trade_category_id)
        }
      }
    }
    if (missingTrades.length > 0) {
      const names = missingTrades.map((id) => TRADE_CATEGORIES.find((t) => t.id === id)?.name ?? `Trade ${id}`)
      topRisks.push(`${names.join(', ')} ${names.length > 1 ? 'were' : 'was'} identified as in-scope but has no priced line items.`)
      recommendedActions.push(`Review ${names.join(', ')} — scope reasoning expected line items here.`)
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
      .select('confidence_score')
      .eq('id', quoteId)
      .single()

    const overallConfidence = quote?.confidence_score ?? null

    if (recommendedActions.length === 0) {
      recommendedActions.push('No material risks detected — this estimate is ready for review.')
    }

    const report: QAReport = {
      top_risks: topRisks.slice(0, 5),
      review_items: reviewItems.slice(0, 10),
      recommended_actions: recommendedActions.slice(0, 5),
      missing_trades: missingTrades,
      duplicate_descriptions: duplicateDescriptions.slice(0, 10),
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
