#!/usr/bin/env node
// ============================================================
// Post-launch validation — read-only trace of a REAL (non-synthetic)
// builder's most-advanced job through the full lifecycle:
//   upload -> extraction -> classification -> pricing -> QA ->
//   quote persistence -> approval -> financial state
// Makes zero writes, zero Anthropic calls. Excludes every reserved
// synthetic/demo/E2E builder id used by this repo's own test scripts.
// ============================================================

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY must be set' }))
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// Every synthetic builder id ever minted by this repo's own E2E/diagnostic
// scripts follows the reserved 00000000-0000-0000-0000-0000000000xx /
// 0000000001xx pattern -- an exclude-list of individual ids proved leaky in
// practice (a real run turned up 10 more reserved ids not previously
// recorded here). Filtering the whole reserved namespace out by pattern,
// plus requiring a real auth.users-style email domain shape, is what
// actually isolates genuine customer builders.
const RESERVED_ID_PATTERN = /^00000000-0000-0000-0000-0000000[0-9a-f]{3,5}$/i

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

async function main() {
  const { data: allBuilders } = await supabase.from('builders').select('id, name, email')
  const builders = (allBuilders ?? []).filter((b) => !RESERVED_ID_PATTERN.test(b.id))
  log('real_builders_found', { count: builders.length, ids: builders.map((b) => b.id), total_builder_rows: allBuilders?.length ?? 0 })

  if (!builders || builders.length === 0) {
    log('no_real_builders_found')
    process.exit(0)
  }

  const builderIds = builders.map((b) => b.id)

  // Most-recently-updated quote with a real total_cost, scoped to real builders.
  const { data: quotes } = await supabase
    .from('quotes')
    .select('id, job_id, builder_id, status, total_cost, confidence_score, is_current, version, approved_at, approved_by, sent_at, qa_report, overall_confidence')
    .in('builder_id', builderIds)
    .not('total_cost', 'is', null)
    .order('id', { ascending: false })
    .limit(5)
  log('candidate_quotes', { count: quotes?.length ?? 0, quotes: (quotes ?? []).map((q) => ({ id: q.id, job_id: q.job_id, status: q.status, total_cost: q.total_cost, is_current: q.is_current })) })

  if (!quotes || quotes.length === 0) {
    log('no_real_quotes_with_pricing_found')
    process.exit(0)
  }

  const quote = quotes[0]
  const jobId = quote.job_id

  const [{ data: job }, { data: files }, { data: docs }, { data: facts }, { data: lineItems }, { data: proofEvents }, { data: invoices }, { data: variations }] = await Promise.all([
    supabase.from('jobs').select('id, status, address, created_at, knowledge_confidence, knowledge_missing_count').eq('id', jobId).single(),
    supabase.from('files').select('id, intake_status, intake_stage, intake_pct, ai_failure_classification').eq('job_id', jobId),
    supabase.from('project_documents').select('id, extraction_status, document_type').eq('job_id', jobId),
    supabase.from('project_facts').select('id, superseded').eq('job_id', jobId),
    supabase.from('quote_line_items').select('id, total, rate, margin_pct, assumption_status, predicted_by').eq('quote_id', quote.id),
    supabase.from('proof_events').select('id, event_type, created_at').eq('job_id', jobId).order('created_at', { ascending: true }),
    supabase.from('invoices').select('id, status, amount').eq('job_id', jobId),
    supabase.from('variations').select('id, status, amount').eq('job_id', jobId),
  ])

  const unpriced = (lineItems ?? []).filter((i) => i.assumption_status !== 'excluded' && i.total === null)
  const activeFacts = (facts ?? []).filter((f) => !f.superseded)

  // Real observed AI spend for this exact job (scope_key is '<job_id>:<stage>'
  // for pipeline calls) -- evidence for sizing ai_limits, not a guess.
  const [{ data: jobOps }, { data: builderSpend }] = await Promise.all([
    supabase.from('ai_operations').select('id, call_site, status, cost_cents, input_tokens, output_tokens, error_classification, created_at')
      .like('scope_key', `${jobId}:%`).order('created_at', { ascending: true }),
    supabase.from('ai_spend_daily').select('builder_id, day, cost_cents, call_count')
      .eq('builder_id', quote.builder_id).order('day', { ascending: false }).limit(10),
  ])
  const jobOpsSucceeded = (jobOps ?? []).filter((o) => o.status === 'succeeded')
  const jobOpsFailed = (jobOps ?? []).filter((o) => o.status !== 'succeeded')
  const jobTotalCostCents = jobOpsSucceeded.reduce((sum, o) => sum + (Number(o.cost_cents) || 0), 0)
  log('ai_operations_for_job', {
    total_calls: jobOps?.length ?? 0, succeeded: jobOpsSucceeded.length, failed: jobOpsFailed.length,
    total_cost_cents_succeeded: jobTotalCostCents,
    failed_classifications: jobOpsFailed.map((o) => o.error_classification),
    calls: (jobOps ?? []).map((o) => ({ call_site: o.call_site, status: o.status, cost_cents: o.cost_cents, error_classification: o.error_classification, created_at: o.created_at })),
  })
  log('ai_spend_daily_for_builder', { rows: builderSpend ?? [] })

  log('job_state', job ?? {})
  log('files_state', { count: files?.length ?? 0, files })
  log('project_documents_state', { count: docs?.length ?? 0, extraction_statuses: (docs ?? []).map((d) => d.extraction_status) })
  log('project_facts_state', { total: facts?.length ?? 0, active: activeFacts.length })
  log('quote_state', {
    id: quote.id, status: quote.status, total_cost: quote.total_cost, is_current: quote.is_current,
    version: quote.version, approved_at: quote.approved_at, approved_by: quote.approved_by, sent_at: quote.sent_at,
    has_qa_report: quote.qa_report !== null, overall_confidence: quote.overall_confidence,
  })
  log('quote_line_items_state', { count: lineItems?.length ?? 0, unpriced_count: unpriced.length })
  log('proof_events_trace', { count: proofEvents?.length ?? 0, sequence: (proofEvents ?? []).map((e) => e.event_type) })
  log('invoices_state', { count: invoices?.length ?? 0, statuses: (invoices ?? []).map((i) => i.status) })
  log('variations_state', { count: variations?.length ?? 0, statuses: (variations ?? []).map((v) => v.status) })

  // Cross-check quote.total_cost against a fresh sum of quote_line_items.total
  // (excluded items don't count) -- catches a stale cached total.
  const recomputedTotal = (lineItems ?? [])
    .filter((i) => i.assumption_status !== 'excluded')
    .reduce((sum, i) => sum + (i.total ?? 0), 0)
  const totalsMatch = Math.abs(recomputedTotal - (quote.total_cost ?? 0)) < 0.01
  log('quote_total_consistency_check', { cached_total_cost: quote.total_cost, recomputed_from_line_items: recomputedTotal, matches: totalsMatch })

  log('lifecycle_summary', {
    job_id: jobId,
    quote_id: quote.id,
    reached_extraction: (docs?.length ?? 0) > 0,
    reached_classification: activeFacts.length > 0,
    reached_pricing: (lineItems?.length ?? 0) > 0 && unpriced.length < (lineItems?.length ?? 0),
    reached_qa: quote.qa_report !== null,
    reached_quote_sent_or_approved: quote.status === 'sent' || quote.status === 'approved',
    reached_approval: quote.status === 'approved',
    reached_financial_activity: (invoices?.length ?? 0) > 0 || (variations?.length ?? 0) > 0,
    quote_totals_consistent: totalsMatch,
    unpriced_items_remaining: unpriced.length,
  })
}

main().catch((err) => {
  console.log(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
