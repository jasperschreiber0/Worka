// ─── Quote send/export/share policy — the single enforcement layer ────────────
// Every external quote surface (confirm-send, export-pdf, the email-draft
// send path) must go through decideQuoteSendPolicy before producing
// client-facing output. None of them should re-implement BLOCKED/
// REVIEW_REQUIRED handling on their own — that duplication is exactly what
// let export-pdf and the chat email-draft path bypass the gate entirely
// (see the Phase 1.2 production trust audit).
//
// loadQuoteQualityGate/loadDemoQuoteQualityGate are the one fetch+evaluate
// implementation every real-mode/demo-mode route shares, so "GET and
// confirm-send use identical inputs" holds by construction, not by
// discipline.

import type { SupabaseClient } from '@supabase/supabase-js'
import { DEMO_QUOTE, DEMO_LINE_ITEMS } from '@/lib/quote-demo'
import { evaluateQualityGate } from './quality-gate'
import type { QualityGateResult, QualityGateLineItem } from './quality-gate'
import type { RiskAcknowledgementSnapshot } from '@/lib/types/database.types'

export interface LoadedQuoteForGate {
  jobId: string
  version: number
  totalCost: number
  overallConfidence: number | null
  status: string
  riskAcknowledgedAt: string | null
  qaReport: { top_risks?: string[]; review_items?: string[]; missing_trades?: number[] } | null
  items: QualityGateLineItem[]
}

/**
 * Fetches exactly what evaluateQualityGate needs, fresh, for a given quote —
 * the one fetch+evaluate implementation shared by every real-mode server
 * route that needs to know a quote's send/export-eligibility. Never trust a
 * client-supplied quality_gate; always call this server-side at the moment
 * of the action.
 */
export async function loadQuoteQualityGate(
  supabase: SupabaseClient,
  quoteId: string,
  builderId: string
): Promise<{ quote: LoadedQuoteForGate; gate: QualityGateResult } | null> {
  const { data: quoteRow } = await supabase
    .from('quotes')
    .select('job_id, version, total_cost, overall_confidence, qa_report, status, risk_acknowledged_at')
    .eq('id', quoteId)
    .eq('builder_id', builderId)
    .single()

  if (!quoteRow) return null

  const { data: lineRows } = await supabase
    .from('quote_line_items')
    .select('id, description, total, rate, pricing_type, is_assumption, assumption_status')
    .eq('quote_id', quoteId)

  const items = (lineRows ?? []) as QualityGateLineItem[]
  const qaReport = quoteRow.qa_report as LoadedQuoteForGate['qaReport']

  const gate = evaluateQualityGate({
    overall_confidence: quoteRow.overall_confidence ?? null,
    unresolved_count: items.filter((i) => i.is_assumption && i.assumption_status === 'unresolved').length,
    missing_trades: qaReport?.missing_trades ?? [],
    top_risks: qaReport?.top_risks ?? [],
    total_cost: quoteRow.total_cost ?? 0,
    items,
  })

  return {
    quote: {
      jobId: quoteRow.job_id,
      version: quoteRow.version ?? 1,
      totalCost: quoteRow.total_cost ?? 0,
      overallConfidence: quoteRow.overall_confidence ?? null,
      status: quoteRow.status,
      riskAcknowledgedAt: quoteRow.risk_acknowledged_at ?? null,
      qaReport,
      items,
    },
    gate,
  }
}

/** Demo-mode equivalent — same evaluateQualityGate call over DEMO_QUOTE/
 * DEMO_LINE_ITEMS, so demo and real mode can never disagree on the decision
 * logic (no separate hand-authored demo gate result). */
export function loadDemoQuoteQualityGate(): { quote: LoadedQuoteForGate; gate: QualityGateResult } {
  const items = DEMO_LINE_ITEMS as unknown as QualityGateLineItem[]
  const gate = evaluateQualityGate({
    overall_confidence: DEMO_QUOTE.overall_confidence ?? null,
    unresolved_count: items.filter((i) => i.is_assumption && i.assumption_status === 'unresolved').length,
    missing_trades: DEMO_QUOTE.qa_report?.missing_trades ?? [],
    top_risks: DEMO_QUOTE.qa_report?.top_risks ?? [],
    total_cost: DEMO_QUOTE.total_cost,
    items,
  })
  return {
    quote: {
      jobId: DEMO_QUOTE.job_id,
      version: DEMO_QUOTE.version,
      totalCost: DEMO_QUOTE.total_cost,
      overallConfidence: DEMO_QUOTE.overall_confidence ?? null,
      status: DEMO_QUOTE.status,
      riskAcknowledgedAt: DEMO_QUOTE.risk_acknowledged_at ?? null,
      qaReport: DEMO_QUOTE.qa_report ?? null,
      items,
    },
    gate,
  }
}

export interface QuotePolicyDecision {
  allowed: boolean
  /** True when acknowledgement is what stands between "not allowed" and "allowed". */
  requiresAcknowledgement: boolean
  reason: string | null
  gate: QualityGateResult
}

/**
 * The one decision every external quote surface must obey.
 * BLOCKED is never satisfiable by acknowledgement — integrity failures are a
 * defect to fix, not a risk to accept (see quality-gate.ts). REVIEW_REQUIRED
 * is satisfiable once `acknowledged` is true, whether that's a fresh
 * acknowledgement on this request or a pre-existing one already recorded on
 * the quote (quote.risk_acknowledged_at !== null).
 */
export function decideQuoteSendPolicy(gate: QualityGateResult, acknowledged: boolean): QuotePolicyDecision {
  if (gate.state === 'blocked') {
    return {
      allowed: false,
      requiresAcknowledgement: false,
      reason: gate.blocked_reasons.join(' '),
      gate,
    }
  }
  if (gate.state === 'review_required' && !acknowledged) {
    return {
      allowed: false,
      requiresAcknowledgement: true,
      reason: 'Flagged risks require acknowledgement before this quote can be sent, exported, or shared with the client.',
      gate,
    }
  }
  return {
    allowed: true,
    requiresAcknowledgement: gate.state === 'review_required',
    reason: null,
    gate,
  }
}

/**
 * Builds the self-contained risk-acceptance record — the SAME shape used for
 * both quotes.risk_acknowledgement_snapshot and the Proof event metadata, so
 * the two can never drift apart (closes the finding where the proof event
 * used a narrower/different reason list than what was actually shown to and
 * accepted by the builder).
 */
export function buildRiskAcknowledgementSnapshot(
  quoteId: string,
  quote: LoadedQuoteForGate,
  gate: QualityGateResult,
  acknowledgedAt: string
): RiskAcknowledgementSnapshot {
  return {
    quote_id: quoteId,
    version: quote.version,
    overall_confidence: quote.overallConfidence,
    exposure: gate.exposure,
    // The complete list of reasons actually shown to and accepted by the
    // builder (confidence threshold, exposure threshold, AND qa_report.
    // top_risks combined) — not qa_report.top_risks alone, which can be
    // empty even when confidence/exposure is what triggered REVIEW_REQUIRED.
    reasons_accepted: gate.review_reasons,
    review_items: quote.qaReport?.review_items ?? [],
    affected_line_items: gate.affected_line_items,
    acknowledged_at: acknowledgedAt,
  }
}
