// ─── Estimate Attribution Accuracy — classification foundation ────────────────
// Phase 2B of the learning loop. Pure function only: no database access, no
// writes, no reporting. Answers "was WorkA wrong, did reality change, or did
// the builder just exercise judgement" for an already-captured reason code
// (assumptions.resolution_reason / variations.origin_reason, migrations
// 039/040) — it does not compute or persist anything new, it classifies data
// that already exists. Reporting on top of this is a deliberately later phase.

import type { AssumptionResolutionReason, VariationOriginReason } from '@/lib/types/database.types'

export type AttributionCategory =
  | 'worka_error'
  | 'external_change'
  | 'builder_judgement'
  | 'unclassified'

const ASSUMPTION_REASON_ATTRIBUTION: Record<AssumptionResolutionReason, AttributionCategory> = {
  ai_extraction_error: 'worka_error',
  document_unclear: 'worka_error',
  scope_missing: 'worka_error',
  builder_adjustment: 'builder_judgement',
  market_rate_change: 'external_change',
  client_change: 'external_change',
  other: 'unclassified',
}

const VARIATION_REASON_ATTRIBUTION: Record<VariationOriginReason, AttributionCategory> = {
  estimating_error: 'worka_error',
  missing_scope: 'worka_error',
  client_change: 'external_change',
  site_condition: 'external_change',
  design_change: 'external_change',
  supplier_price_change: 'external_change',
  regulatory_requirement: 'external_change',
  other: 'unclassified',
}

/**
 * Classifies an assumption resolution reason or a variation origin reason
 * into an attribution category. Returns null only when reason itself is
 * null (nothing to classify) — a non-null reason always resolves to at
 * least 'unclassified' ('other').
 */
export function getAttributionCategory(
  reason: AssumptionResolutionReason | VariationOriginReason | null
): AttributionCategory | null {
  if (reason === null) return null
  if (reason in ASSUMPTION_REASON_ATTRIBUTION) {
    return ASSUMPTION_REASON_ATTRIBUTION[reason as AssumptionResolutionReason]
  }
  if (reason in VARIATION_REASON_ATTRIBUTION) {
    return VARIATION_REASON_ATTRIBUTION[reason as VariationOriginReason]
  }
  return 'unclassified'
}
