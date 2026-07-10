// ─── Canonical validation gates ────────────────────────────────────────────────
// Single specification for turning an extracted line item into an assumption
// (or excluding it outright). Previously reimplemented four times with drifting
// wording (smooth-responder, the dead worker route, the dead lib/estimate.ts —
// which added an extra 4th gate nothing else had — and re-derived a fifth way,
// from current line-item state, on every read in the assumptions API). Now:
// the gate is computed once, here, at extraction time, and persisted on the
// assumption row (assumptions.gate) — never re-derived.
//
// Gate 1 — no unit: the quantity cannot be safely priced.
// Gate 2 — quantity present but not traceable to a dimension/evidence source.
// Gate 3 — quantity is invalid (<= 0): excluded from the quote outright.
//
// PC (prime cost) and provisional sum items are exempt from Gates 1 & 2 — they
// are allowances by definition, not measured quantities (see CLAUDE.md).

export type Gate = 1 | 2 | 3

export type PricingTypeForGating = 'measured' | 'pc_allowance' | 'provisional_sum'

export interface GateableItem {
  description: string
  quantity: number | null
  unit: string | null
  dimensions_string: string | null
  pricing_type?: PricingTypeForGating
  /** True when the line's cost basis came directly from a priced source document. */
  has_document_price?: boolean
}

export interface GateResult {
  gate: Gate | null
  is_assumption: boolean
  assumption_status: 'unresolved' | 'excluded' | null
  message: string | null
}

export function applyValidationGates(item: GateableItem): GateResult {
  const exempt =
    item.pricing_type === 'pc_allowance' ||
    item.pricing_type === 'provisional_sum' ||
    item.has_document_price === true

  if (!item.unit && !exempt) {
    return {
      gate: 1,
      is_assumption: true,
      assumption_status: 'unresolved',
      message: `Quantity unit not specified — confirm the unit for ${item.description}`,
    }
  }

  if (item.quantity !== null && item.quantity <= 0) {
    return {
      gate: 3,
      is_assumption: true,
      assumption_status: 'excluded',
      message: `Invalid quantity (${item.quantity}) for ${item.description} — excluded from quote`,
    }
  }

  if (item.quantity !== null && !item.dimensions_string && !exempt) {
    return {
      gate: 2,
      is_assumption: true,
      assumption_status: 'unresolved',
      message: `Quantity could not be verified from source documents — confirm ${item.quantity} ${item.unit ?? ''} for ${item.description}`.trim(),
    }
  }

  return { gate: null, is_assumption: false, assumption_status: null, message: null }
}

/**
 * Best-effort gate inference for legacy assumption rows written before the
 * `gate` column existed (assumptions.gate IS NULL). New rows always carry a
 * persisted gate and never need this.
 */
export function inferLegacyGate(li: {
  unit: string | null
  quantity: number | null
  dimensions_string: string | null
} | null): Gate {
  if (!li?.unit) return 1
  if (li.quantity !== null && li.quantity !== undefined && li.quantity <= 0) return 3
  if (!li.dimensions_string) return 2
  return 2
}
