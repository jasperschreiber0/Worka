// ─── Job Closeout v1 — Wire Existing Reconciliation to the Canonical Snapshot ──
//
// Pure data assembly only. The reconciliation calculation itself (cost_reconciliation
// writes, rate learning, builder accuracy) lives entirely in
// POST /api/estimation/reconcile (app/api/estimation/reconcile/route.ts) and is not
// duplicated here — this module's only job is building that endpoint's expected
// `{ trade_category_id, estimated_cost, actual_cost }[]` payload from data the
// canonical job snapshot already has: the quote's per-trade estimated totals
// (line_items_by_category) and the Financials v1 actual-cost ledger
// (job_cost_entries, migration 097).
//
// Schema constraint that shapes this file: cost_reconciliation.trade_category_id
// is NOT NULL (migration 011) — the reconciliation contract is inherently
// trade-scoped and has no slot for a cost that isn't attributed to one of the
// 13 locked trade categories. job_cost_entries.trade_category_id IS nullable
// (migration 097 — e.g. a council permit fee or a skip bin hire has no trade).
// Forcing such a cost into an arbitrary trade bucket would corrupt that trade's
// learned rate with cost that was never actually spent on it, so this module
// deliberately does NOT invent one — unclassified costs are excluded from
// `entries` by construction and surfaced separately (`unclassifiedCostTotal` /
// `unclassifiedCostCount`) so the caller can show the builder what was left out
// rather than silently dropping it. This mirrors the existing CloseOutJobDrawer's
// own behaviour (components/jobs/CloseOutJobDrawer.tsx), which never reads
// job_cost_entries at all and only ever reconciles the quote's own trades.

export interface ReconciliationTrade {
  trade_category_id: number
  estimated_cost: number
}

export interface JobCostRow {
  trade_category_id: number | null
  amount: number
}

export interface ReconciliationEntry {
  trade_category_id: number
  estimated_cost: number
  actual_cost: number | null
}

export interface BuildReconciliationEntriesResult {
  entries: ReconciliationEntry[]
  /** Sum of job_cost_entries rows with no trade_category_id — cannot be represented in `entries`; see header comment. */
  unclassifiedCostTotal: number
  unclassifiedCostCount: number
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Builds the `entries` payload for POST /api/estimation/reconcile from the
 * quote's per-trade estimated costs and the job's logged actual-cost rows.
 *
 * - One entry per trade present on the quote (never invented, never dropped).
 * - `actual_cost` is the sum of job_cost_entries logged against that trade,
 *   or `null` if nothing has been logged for it yet — matching the existing
 *   "leave a trade blank" semantics the reconcile endpoint and
 *   CloseOutJobDrawer already treat as a valid, known-unknown state.
 * - Cost rows with no trade_category_id are excluded from `entries` (the
 *   schema has no way to represent them) and reported separately instead.
 */
export function buildReconciliationEntries(
  trades: ReconciliationTrade[],
  costRows: JobCostRow[]
): BuildReconciliationEntriesResult {
  const actualByTrade = new Map<number, number>()
  let unclassifiedCostTotal = 0
  let unclassifiedCostCount = 0

  for (const row of costRows) {
    if (row.trade_category_id === null) {
      unclassifiedCostTotal += row.amount
      unclassifiedCostCount += 1
      continue
    }
    const prev = actualByTrade.get(row.trade_category_id) ?? 0
    actualByTrade.set(row.trade_category_id, round2(prev + row.amount))
  }

  const entries: ReconciliationEntry[] = trades.map((t) => ({
    trade_category_id: t.trade_category_id,
    estimated_cost: t.estimated_cost,
    actual_cost: actualByTrade.has(t.trade_category_id) ? actualByTrade.get(t.trade_category_id)! : null,
  }))

  return {
    entries,
    unclassifiedCostTotal: round2(unclassifiedCostTotal),
    unclassifiedCostCount,
  }
}
