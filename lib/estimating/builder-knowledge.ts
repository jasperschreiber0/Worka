// ─── Builder Knowledge Defaults ─────────────────────────────────────────────
// The deterministic lookup capability from the "Permanent Reasoning
// Architecture" design, built exactly as scoped after the subtraction pass:
// a small, curated, jurisdiction-keyed table — NOT an AI engine, NOT a
// prompt instruction. Every row in builder_knowledge_defaults (migration
// 086) carries a real, checkable legal/standard citation. The LLM never
// invents these — this module only ever reads a table a human wrote.
//
// Why this can't be a Stage 3 prompt instruction like the system→components
// decomposition was: getting a legal default wrong (telling a builder
// termite protection or HBC insurance doesn't apply) is a liability matter,
// not a construction-judgment matter. Determinism and auditability are the
// whole point — see this table's own header comment in the migration.

import type { SupabaseClient } from '@supabase/supabase-js'
import { detectCharacteristics } from './construction-sanity.ts'

export interface BuilderKnowledgeDefault {
  id: string
  jurisdiction: string
  trigger_characteristic: string
  trade_category_id: number
  description: string
  citation: string
  allowance_value: number
  pricing_basis: string
}

export interface BuilderKnowledgeContext {
  jurisdiction: string
  /** Project characteristics already known — reuses construction-sanity's
   *  ProjectCharacteristic values (extension/second_storey/major_renovation/
   *  new_build/demolition) plus 'has_new_footings' and 'has_pool', derived
   *  below from the quote's own line items so this never depends on a
   *  document explicitly stating them in words. */
  characteristics: string[]
  /** Lowercased descriptions of every line item already in the quote —
   *  used only to avoid inserting a duplicate default when the relevant
   *  item already exists (e.g. Stage 6 already produced a pool
   *  certification line via the system-decomposition prompt). */
  existingDescriptions: string[]
}

// One short, distinguishing keyword per default — deliberately hand-picked,
// not derived automatically, so a coincidental partial match can't silently
// suppress a real statutory default. Keyed by the default's `description`
// so this stays correct even if seed rows are reordered.
const DUPLICATE_KEYWORDS: Record<string, string[]> = {
  'Home Building Compensation (HBC) insurance': ['hbc', 'home building compensation', 'builders insurance', 'builder\'s insurance'],
  'Termite protection system': ['termite'],
  'Asbestos survey and removal allowance': ['asbestos'],
  'Waste management and disposal': ['waste management', 'skip bin', 'site waste'],
  'Sediment and erosion control': ['sediment', 'erosion control'],
  'Temporary works — site fencing and protection of existing structure': ['temporary fencing', 'site fencing', 'hoarding', 'temporary works'],
  'Pool safety certification': ['pool safety cert', 'pool certification'],
  'BASIX certificate and NCC compliance sign-off': ['basix', 'ncc compliance'],
}

function isAlreadyCovered(item: BuilderKnowledgeDefault, existingDescriptions: string[]): boolean {
  const keywords = DUPLICATE_KEYWORDS[item.description] ?? []
  if (keywords.length === 0) return false
  return existingDescriptions.some((d) => keywords.some((k) => d.includes(k)))
}

/**
 * Derives the two quote-specific characteristics (has_new_footings,
 * has_pool) this module needs beyond what construction-sanity already
 * detects from project facts/scope text. Kept separate from
 * construction-sanity's own ProjectCharacteristic type deliberately —
 * these two are line-item-evidence-based (a real Trade 1 item, a real
 * pool mention), not project-description-based.
 */
export function deriveBuilderKnowledgeCharacteristics(
  lineItems: Array<{ trade_category_id: number; description: string }>
): string[] {
  const extra: string[] = []
  if (lineItems.some((i) => i.trade_category_id === 1)) extra.push('has_new_footings')
  if (lineItems.some((i) => i.description.toLowerCase().includes('pool'))) extra.push('has_pool')
  return extra
}

/**
 * Returns the subset of defaults that apply to this job (trigger matches a
 * detected characteristic, or is 'always') and aren't already covered by an
 * existing line item. Pure, deterministic, no DB access — the caller
 * fetches the seed rows and existing line items.
 */
export function evaluateBuilderKnowledgeDefaults(
  defaults: BuilderKnowledgeDefault[],
  ctx: BuilderKnowledgeContext
): BuilderKnowledgeDefault[] {
  return defaults.filter((d) => {
    if (d.jurisdiction !== ctx.jurisdiction) return false
    const triggerMatches = d.trigger_characteristic === 'always' || ctx.characteristics.includes(d.trigger_characteristic)
    if (!triggerMatches) return false
    return !isAlreadyCovered(d, ctx.existingDescriptions)
  })
}

// ─── DB-applying wrapper ────────────────────────────────────────────────────
// Separate from the pure function above so the matching LOGIC stays unit-
// testable without a database — this is only the plumbing around it.
// Deliberately NOT part of lib/pricing.ts: inserting a previously-absent
// line item closes a scope gap, it does not adjust the rate of anything
// that already existed, so this stays out of the rate-resolution module
// entirely. Called once from runQualityAssurance (qa.ts), before the rest
// of QA reads line items, so missing-trade/coverage/construction-sanity
// checks all see the same, already-topped-up scope.

export interface AppliedBuilderKnowledgeDefault {
  description: string
  citation: string
  allowance_value: number
  trade_category_id: number
}

/**
 * Inserts any missing builder-knowledge default as a new quote_line_item —
 * pricing_type provisional_sum, is_assumption/assumption_status='unresolved'
 * so it flows through the EXISTING accept/adjust/exclude review UI
 * (AssumptionReview.tsx) rather than a new surface, with pricing_basis
 * carrying the citation verbatim so the builder sees the legal source, not
 * just a number. Returns what was actually applied, for cost-impact
 * reporting. Idempotent per quote: re-running after defaults already exist
 * inserts nothing further (isAlreadyCovered matches on the same keywords).
 */
export async function applyBuilderKnowledgeDefaults(
  supabase: SupabaseClient,
  quoteId: string,
  jobId: string
): Promise<AppliedBuilderKnowledgeDefault[]> {
  const { data: existingItems } = await supabase
    .from('quote_line_items')
    .select('trade_category_id, description')
    .eq('quote_id', quoteId)

  const { data: defaultsRows } = await supabase
    .from('builder_knowledge_defaults')
    .select('id, jurisdiction, trigger_characteristic, trade_category_id, description, citation, allowance_value, pricing_basis')
    .eq('active', true)

  if (!defaultsRows || defaultsRows.length === 0) return []

  const { data: factRows } = await supabase
    .from('project_facts')
    .select('value')
    .eq('job_id', jobId)
    .eq('superseded', false)
    .limit(300)
  const projectFactsText = (factRows ?? []).map((f: { value: string | null }) => f.value ?? '').join(' ')

  const lineItemsForCharacteristics = (existingItems ?? []) as Array<{ trade_category_id: number; description: string }>
  const characteristics = [
    ...detectCharacteristics({ lineItems: lineItemsForCharacteristics.map((i) => ({ ...i, quantity: null, unit: null, assumption_status: null })), scopeItems: [], projectFactsText }),
    ...deriveBuilderKnowledgeCharacteristics(lineItemsForCharacteristics),
  ]

  const existingDescriptions = lineItemsForCharacteristics.map((i) => i.description.toLowerCase())
  const toApply = evaluateBuilderKnowledgeDefaults(defaultsRows as BuilderKnowledgeDefault[], {
    jurisdiction: 'NSW',
    characteristics,
    existingDescriptions,
  })

  if (toApply.length === 0) return []

  const { error } = await supabase.from('quote_line_items').insert(
    toApply.map((d) => ({
      quote_id: quoteId,
      trade_category_id: d.trade_category_id,
      description: d.description,
      quantity: 1,
      unit: 'lot',
      rate: null,
      total: d.allowance_value,
      confidence: 75,
      is_assumption: true,
      assumption_status: 'unresolved',
      pricing_type: 'provisional_sum',
      allowance_value: d.allowance_value,
      pricing_basis: `${d.pricing_basis} Source: ${d.citation}.`,
      margin_pct: 0.15,
    }))
  )
  if (error) {
    console.error('applyBuilderKnowledgeDefaults: insert failed', error)
    return []
  }

  console.log(JSON.stringify({
    event: 'builder_knowledge_defaults_applied', quote_id: quoteId, job_id: jobId,
    count: toApply.length, descriptions: toApply.map((d) => d.description),
  }))

  return toApply.map((d) => ({ description: d.description, citation: d.citation, allowance_value: d.allowance_value, trade_category_id: d.trade_category_id }))
}
