// ─── Stage 8: Quality Assurance ────────────────────────────────────────────────
// Runs once, Next.js-side, immediately after pricing resolves rates and totals
// (lib/pricing.ts ensureQuotePriced) and before the estimate is rendered to the
// builder. Never throws — a QA failure must not block the quote being shown.

import type { SupabaseClient } from '@supabase/supabase-js'
import { TRADE_CATEGORIES } from '@/lib/trade-taxonomy'
import type { QAReport } from '@/lib/types/database.types'

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
  confidence: number | null
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
      .select('id, trade_category_id, description, quantity, unit, rate, confidence, assumption_status')
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

    // ── Unpriced / low-confidence items ──
    const unpriced = included.filter((i) => i.rate === null)
    if (unpriced.length > 0) {
      reviewItems.push(`${unpriced.length} line item${unpriced.length !== 1 ? 's' : ''} could not be priced from any rate tier.`)
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
