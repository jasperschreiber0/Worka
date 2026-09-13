// Generic compliance references are advisory only. They must never create
// billable scope or seed prices automatically when a builder opens a quote.

import type { SupabaseClient } from '@supabase/supabase-js'


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

export interface AppliedBuilderKnowledgeDefault {
  description: string
  citation: string
  allowance_value: number
  trade_category_id: number
}

/**
 * Reviewing a quote must never manufacture scope or prices from generic
 * statutory defaults. A citation does not establish applicability to this
 * project, and a seeded allowance is not a supplier or builder price.
 * Retain the compatibility entry point while existing QA callers migrate;
 * compliance questions belong in review, not automatic billable line items.
 */
export async function applyBuilderKnowledgeDefaults(
  _supabase: SupabaseClient,
  _quoteId: string,
  _jobId: string
): Promise<AppliedBuilderKnowledgeDefault[]> {
  return []
}
