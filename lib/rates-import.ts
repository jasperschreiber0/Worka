// ─── Supplier rate import — matching plan (pure, dependency-free) ──────────
//
// FIX (Round 10 reliability audit, persistence truthfulness): imported
// supplier rates used to be persisted under a description-derived
// line_item_key (`${trade_category_id}_${slug(description)}`) that could
// never equal a real catalogue key. resolveRateForKey's Tier 3
// (lib/pricing.ts) only ever matches by EXACT line_item_key equality, and
// matchLineItemKey only ever returns keys drawn from loadPricingCatalogue
// (cost_rates + market_material_prices) — so every imported row was
// structurally unreachable by pricing while the import route reported
// success. This module resolves each imported row against that SAME
// catalogue before persistence: a row that matches is stored under the
// catalogue's own key (genuinely reachable); a row that doesn't match is
// reported back, never silently persisted as an unreachable rate.
//
// Relative, .ts-suffixed import — same reason invoices.ts/variations.ts
// document: resolves identically under plain `node --experimental-strip-types`
// (this file's own .test.ts) and under Next.js/webpack.
import { matchLineItemKey, type CatalogueEntry } from './pricing.ts'

export interface SupplierRateInput {
  trade_category_id: number
  trade_category_name: string
  description: string
  unit: string
  rate: number
}

export interface MatchedSupplierRate {
  builder_id: string
  supplier_name: string
  line_item_key: string
  rate: number
  unit: string
  imported_at: string
}

export interface SupplierRateImportPlan {
  matched: MatchedSupplierRate[]
  unmatched: SupplierRateInput[]
}

/**
 * Splits a raw import payload into rows that genuinely match a real
 * catalogue entry (and so are reachable by pricing) versus rows that don't
 * (and so must never be silently persisted as an unreachable rate).
 * Deliberately does not deduplicate matched rows sharing a line_item_key —
 * that's the caller's upsert to handle, and collapsing here would hide a
 * genuine "two supplier lines matched the same catalogue entry" signal.
 */
export function planSupplierRateImport(
  rates: SupplierRateInput[],
  catalogue: CatalogueEntry[],
  builderId: string,
  supplierName: string,
  importedAt: string
): SupplierRateImportPlan {
  const matched: MatchedSupplierRate[] = []
  const unmatched: SupplierRateInput[] = []

  for (const r of rates) {
    const match = matchLineItemKey(
      { trade_category_id: r.trade_category_id, description: r.description, quantity: null, unit: r.unit },
      catalogue
    )
    if (!match) {
      unmatched.push(r)
      continue
    }
    matched.push({
      builder_id: builderId,
      supplier_name: supplierName,
      line_item_key: match.key,
      rate: r.rate,
      unit: r.unit,
      imported_at: importedAt,
    })
  }

  return { matched, unmatched }
}
