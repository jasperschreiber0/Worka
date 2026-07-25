#!/usr/bin/env node
// ============================================================
// WorkA — dev-mode: run Stage 6 completeness recovery against an
// already-generated quote, then re-price and re-QA
// ============================================================
// PURPOSE: exercise the same logic just added to production
// (supabase/functions/smooth-responder/index.ts's completeness recovery
// pass) against an EXISTING quote, without re-running the whole Stage 1-6
// pipeline. That production logic lives inside a Deno Edge Function
// (`Deno.serve(...)` at module scope, esm.sh imports) so it can't be
// imported directly here — this script re-implements the same call
// sequence in plain Node, reusing every piece of REAL, shared application
// code it can: findMissingTrades / filterNewLineItems / lineItemKey /
// buildTradeRecoveryPrompt / buildTradeRecoveryReport come straight from
// pipeline-logic.ts (dependency-free, so importable identically here and
// from Deno); applyValidationGates comes from lib/estimating/gates.ts;
// priceLineItems/computeQuoteTotals from lib/pricing.ts; runQualityAssurance
// from lib/estimating/qa.ts. Only the Claude tool schema + gate/pricing-
// source glue (ESTIMATE_GENERATION_TOOL, deriveDocPrice, the validated-item
// mapping) is a hand-kept copy of index.ts's own, matching the pattern
// scripts/dev-generate-estimate.mjs already established for Stage 6.
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ANTHROPIC_API_KEY=... \
//     node --experimental-strip-types scripts/dev-recover-missing-trades.mjs \
//       --quote-id=<uuid> --job-id=<uuid>
// ============================================================

import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { applyValidationGates } from '../lib/estimating/gates.ts'
import { tradeCategoryName } from '../lib/trade-taxonomy.ts'
import { priceLineItems, computeQuoteTotals, DEFAULT_MARGIN_PCT } from '../lib/pricing.ts'
import { runQualityAssurance } from '../lib/estimating/qa.ts'
import {
  findMissingTrades, filterNewLineItems, lineItemKey,
  buildTradeRecoveryPrompt, buildTradeRecoveryReport,
} from '../supabase/functions/smooth-responder/pipeline-logic.ts'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=')
    return [k, rest.join('=')]
  })
)

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim()
if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ANTHROPIC_API_KEY')
  process.exit(1)
}
if (!args['quote-id'] || !args['job-id']) {
  console.error('Required: --quote-id=<uuid> --job-id=<uuid>')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
const MODEL = 'claude-sonnet-4-6'
const quoteId = args['quote-id']
const jobId = args['job-id']

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

// Copy of ESTIMATE_GENERATION_TOOL (smooth-responder/index.ts / dev-generate-estimate.mjs).
const ESTIMATE_GENERATION_TOOL = {
  name: 'generate_estimate',
  description: 'Return the full line-item takeoff for the project.',
  input_schema: {
    type: 'object',
    properties: {
      line_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            trade_category_id: { type: 'integer', minimum: 1, maximum: 13 },
            description: { type: 'string' },
            quantity: { type: ['number', 'null'] },
            unit: { type: ['string', 'null'] },
            dimensions_string: { type: ['string', 'null'] },
            confidence: { type: 'integer', minimum: 0, maximum: 100 },
            pricing_type: { type: 'string', enum: ['measured', 'pc_allowance', 'provisional_sum'] },
            source_ref: { type: ['string', 'null'] },
            manual_input_required: { type: 'boolean' },
            document_rate: { type: ['number', 'null'] },
            document_total: { type: ['number', 'null'] },
            allowance_value: { type: ['number', 'null'] },
            pricing_basis: { type: ['string', 'null'] },
          },
          required: ['trade_category_id', 'description', 'confidence', 'pricing_type', 'manual_input_required'],
        },
      },
    },
    required: ['line_items'],
  },
}

// Copy of deriveDocPrice (smooth-responder/index.ts).
function deriveDocPrice(rate, total, quantity) {
  const r = typeof rate === 'number' && isFinite(rate) && rate > 0 ? rate : null
  const t = typeof total === 'number' && isFinite(total) && total > 0 ? total : null
  if (r === null && t === null) return { rate: null, total: null }
  const qty = quantity !== null && quantity > 0 ? quantity : null
  let derivedTotal = t ?? (r !== null && qty !== null ? Math.round(r * qty * 100) / 100 : r)
  let derivedRate = r ?? (t !== null && qty !== null ? Math.round((t / qty) * 100) / 100 : t)
  if (derivedRate === null) derivedRate = derivedTotal
  if (derivedTotal === null) derivedTotal = derivedRate
  return { rate: derivedRate, total: derivedTotal }
}

// Mirrors validateStage6Items (smooth-responder/index.ts) — gate + pricing_source derivation.
function validateItems(rawItems) {
  return rawItems
    .filter((item) => typeof item.trade_category_id === 'number' && item.trade_category_id >= 1 && item.trade_category_id <= 13)
    .map((item) => {
      const docPrice = deriveDocPrice(item.document_rate, item.document_total, item.quantity ?? null)
      const allowanceValueRaw = item.allowance_value
      const allowanceValue = typeof allowanceValueRaw === 'number' && isFinite(allowanceValueRaw) && allowanceValueRaw > 0 ? allowanceValueRaw : null
      const gateResult = applyValidationGates({
        description: String(item.description ?? ''),
        quantity: item.quantity ?? null,
        unit: item.unit ?? null,
        dimensions_string: item.dimensions_string ?? null,
        pricing_type: item.pricing_type ?? 'measured',
        has_document_price: docPrice.total !== null,
        manual_input_required: item.manual_input_required === true,
      })
      const pricingSource = docPrice.total !== null
        ? 'document'
        : allowanceValue !== null
          ? 'ai_allowance'
          : gateResult.gate
            ? 'unresolved'
            : null
      return {
        ...item, ...gateResult,
        _docRate: docPrice.rate, _docTotal: docPrice.total,
        _pricingSource: pricingSource,
        _pricingBasis: typeof item.pricing_basis === 'string' ? item.pricing_basis : null,
        _originalAiValue: docPrice.total ?? allowanceValue ?? null,
        _allowanceTotal: allowanceValue,
      }
    })
}

function buildInsertRows(items, quoteId) {
  return items
    .filter((item) => item.assumption_status !== 'excluded')
    .map((item) => ({
      quote_id: quoteId,
      trade_category_id: item.trade_category_id,
      description: item.description,
      quantity: item.manual_input_required ? null : (item.quantity ?? null),
      unit: item.manual_input_required ? null : (item.unit ?? null),
      rate: item._docRate ?? null,
      total: item._docTotal ?? item._allowanceTotal ?? null,
      confidence: item.confidence ?? 50,
      dimensions_string: item.dimensions_string ?? null,
      is_assumption: item.is_assumption ?? false,
      assumption_status: item.assumption_status ?? null,
      pricing_type: item.pricing_type ?? 'measured',
      source_ref: item.source_ref ? String(item.source_ref).slice(0, 100) : null,
      margin_pct: item.pricing_type === 'provisional_sum' ? 0 : 0.15,
      pricing_source: item._pricingSource,
      pricing_basis: item._pricingBasis,
      original_ai_value: item._originalAiValue,
    }))
}

async function callTool(system, content, tool, maxTokens = 4000) {
  const resp = await anthropic.messages.create({
    model: MODEL, max_tokens: maxTokens, system,
    messages: [{ role: 'user', content }],
    tools: [tool], tool_choice: { type: 'tool', name: tool.name },
  })
  log('claude_call_complete', { tool: tool.name, stop_reason: resp.stop_reason, output_tokens: resp.usage?.output_tokens ?? null })
  const toolUse = resp.content.find((b) => b.type === 'tool_use')
  if (!toolUse) throw new Error(`No tool_use block returned for ${tool.name} (stop_reason: ${resp.stop_reason})`)
  return toolUse.input
}

async function main() {
  const { data: quote, error: quoteErr } = await supabase
    .from('quotes')
    .select('id, builder_id, margin_pct, total_cost')
    .eq('id', quoteId)
    .single()
  if (quoteErr || !quote) throw new Error(`Quote not found: ${quoteErr?.message ?? quoteId}`)
  const beforeTotalCost = quote.total_cost

  const { data: scopeRows, error: scopeErr } = await supabase
    .from('scope_items')
    .select('trade_category_id, included_scope, excluded_scope, assumptions')
    .eq('job_id', jobId)
  if (scopeErr) throw new Error(`Could not load scope_items: ${scopeErr.message}`)

  const { data: factRows } = await supabase
    .from('project_facts')
    .select('category, key, value, evidence, confidence')
    .eq('job_id', jobId)
    .eq('superseded', false)
  const factsBlock = (factRows ?? []).map((f) => `[${f.category}] ${f.key}: ${f.value} (confidence ${f.confidence}%, evidence: ${f.evidence ?? 'n/a'})`).join('\n')

  const { data: currentLineItems } = await supabase
    .from('quote_line_items')
    .select('trade_category_id, description, assumption_status')
    .eq('quote_id', quoteId)
  const existingKeys = new Set((currentLineItems ?? []).map((li) => lineItemKey(li.trade_category_id, li.description)))

  const initialMissingTrades = findMissingTrades(scopeRows ?? [], currentLineItems ?? [])
  log('completeness_check', { job_id: jobId, quote_id: quoteId, initial_missing_trades: initialMissingTrades })

  const recoveryResults = []
  const recoveredDetail = []
  for (const tradeId of initialMissingTrades) {
    const scopeRow = (scopeRows ?? []).find((s) => s.trade_category_id === tradeId)
    if (!scopeRow) { recoveryResults.push({ trade_category_id: tradeId, items_generated: 0 }); continue }
    const tradeName = tradeCategoryName(tradeId)
    const { system, userText } = buildTradeRecoveryPrompt(tradeId, tradeName, scopeRow, factsBlock)
    log('trade_recovery_calling', { job_id: jobId, quote_id: quoteId, trade_category_id: tradeId, trade_name: tradeName })

    let result
    try {
      result = await callTool(system, [{ type: 'text', text: userText }], ESTIMATE_GENERATION_TOOL, 4000)
    } catch (err) {
      log('trade_recovery_failed', { job_id: jobId, trade_category_id: tradeId, error: err.message })
      recoveryResults.push({ trade_category_id: tradeId, items_generated: 0 })
      continue
    }

    const rawItems = (result.line_items ?? []).filter((item) => item.trade_category_id === tradeId)
    if (rawItems.length === 0) { recoveryResults.push({ trade_category_id: tradeId, items_generated: 0 }); continue }

    const validated = validateItems(rawItems)
    const toInsert = filterNewLineItems(validated, existingKeys)
    const inserts = buildInsertRows(toInsert, quoteId)
    if (inserts.length === 0) { recoveryResults.push({ trade_category_id: tradeId, items_generated: 0 }); continue }

    const { data: insertedRaw, error: insertErr } = await supabase
      .from('quote_line_items')
      .upsert(inserts, { onConflict: 'quote_id,trade_category_id,description', ignoreDuplicates: true })
      .select()
    if (insertErr) {
      log('trade_recovery_insert_failed', { job_id: jobId, trade_category_id: tradeId, error: insertErr.message })
      recoveryResults.push({ trade_category_id: tradeId, items_generated: 0 })
      continue
    }
    const inserted = insertedRaw ?? []
    for (const li of inserts) existingKeys.add(lineItemKey(li.trade_category_id, li.description))
    recoveredDetail.push({ trade_category_id: tradeId, trade_name: tradeName, items: inserted.map((i) => i.description) })
    log('trade_recovery_succeeded', { job_id: jobId, trade_category_id: tradeId, items_generated: inserted.length })
    recoveryResults.push({ trade_category_id: tradeId, items_generated: inserted.length })
  }

  const tradeRecoveryReport = buildTradeRecoveryReport(initialMissingTrades, recoveryResults)
  if (initialMissingTrades.length > 0) {
    await supabase.from('quotes').update({ trade_recovery_report: tradeRecoveryReport }).eq('id', quoteId)
  }

  // ── Re-price any newly-recovered items (mirrors dev-reprice-quote.mjs) ──
  const { data: allItems } = await supabase
    .from('quote_line_items')
    .select('id, trade_category_id, description, quantity, unit, rate, total, confidence, assumption_status, pricing_source')
    .eq('quote_id', quoteId)
  const { data: builderRow } = await supabase.from('builders').select('state').eq('id', quote.builder_id).single()
  const unpriced = (allItems ?? []).filter((i) => i.total === null)
  let finalItems = allItems ?? []
  if (unpriced.length > 0) {
    const priced = await priceLineItems(supabase, quote.builder_id, builderRow?.state ?? null, unpriced)
    const rowsToUpdate = priced
      .map((p) => ({ id: p.id, quote_id: quoteId, trade_category_id: p.trade_category_id, description: p.description, rate: p.rate, total: p.total, pricing_source: p.pricing_source, pricing_basis: p.pricing_basis, confidence: p.confidence }))
      .filter((row) => row.rate !== null)
    if (rowsToUpdate.length > 0) {
      await supabase.from('quote_line_items').upsert(rowsToUpdate)
    }
    const pricedById = new Map(priced.map((p) => [p.id, p]))
    finalItems = (allItems ?? []).map((item) => pricedById.get(item.id) ?? item)
  }
  const totals = computeQuoteTotals(finalItems)
  await supabase.from('quotes').update({ ...totals, margin_pct: quote.margin_pct ?? DEFAULT_MARGIN_PCT }).eq('id', quoteId)

  const qaReport = await runQualityAssurance(supabase, quoteId, jobId)

  // ── Final pricing-source breakdown (dollar-weighted) ────────────────────
  const { data: finalAllItems } = await supabase
    .from('quote_line_items')
    .select('total, pricing_source, assumption_status')
    .eq('quote_id', quoteId)
  const included = (finalAllItems ?? []).filter((i) => i.assumption_status !== 'excluded')
  const bucketOf = (source) => {
    if (source === 'document') return 'document_pricing'
    if (source === 'cost_rates_exact' || source === 'cost_rates_normalized' || source === 'builder_rate' || source === 'network_rate') return 'measured_pricing'
    if (source === 'category_rate') return 'category_fallback_pricing'
    if (source === 'ai_measured_rate') return 'ai_measured_rate_pricing'
    if (source === 'ai_allowance') return 'ai_allowance_pricing'
    return 'unresolved'
  }
  const buckets = { measured_pricing: 0, document_pricing: 0, category_fallback_pricing: 0, ai_measured_rate_pricing: 0, ai_allowance_pricing: 0, unresolved: 0 }
  const bucketCounts = { measured_pricing: 0, document_pricing: 0, category_fallback_pricing: 0, ai_measured_rate_pricing: 0, ai_allowance_pricing: 0, unresolved: 0 }
  for (const item of included) {
    const b = bucketOf(item.pricing_source)
    buckets[b] += item.total ?? 0
    bucketCounts[b] += 1
  }
  const totalCost = totals.total_cost || 1
  const bucketPct = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, Math.round((v / totalCost) * 10000) / 100]))

  console.log(JSON.stringify({
    event: 'recovery_run_complete',
    quote_id: quoteId, job_id: jobId,
    before_total_cost: beforeTotalCost,
    after_total_cost: totals.total_cost,
    change: totals.total_cost !== null && beforeTotalCost !== null ? Math.round((totals.total_cost - beforeTotalCost) * 100) / 100 : null,
    initial_missing_trades: tradeRecoveryReport.initial_missing_trades,
    recovered_trades: tradeRecoveryReport.recovered_trades,
    recovered_trade_detail: recoveredDetail,
    remaining_missing_trades: tradeRecoveryReport.remaining_missing_trades,
    price_coverage_pct: totals.price_coverage_pct,
    pricing_match_rate_pct: totals.pricing_match_rate_pct,
    allowance_pct: totals.allowance_pct,
    pricing_source_dollar_breakdown_pct: bucketPct,
    pricing_source_item_counts: bucketCounts,
    qa_top_risks: qaReport?.top_risks ?? [],
    qa_review_items: qaReport?.review_items ?? [],
  }, null, 2))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'recovery_run_failed', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
