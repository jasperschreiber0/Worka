// ─── Rate library matcher (Stage 4) ──────────────────────────────────────────
// User-supplied-rate pricing mode. A builder uploads a rate library (CSV, or
// their stored supplier rates); we match each estimate line to a library rate
// line-by-line, in preference to the market benchmark. Anything with no match is
// FLAGGED (rate_unmatched), never silently left on the market rate — the builder
// must see exactly which scope their library didn't cover.

import type { EstimateLineItem } from './estimate-generation'

export interface RateLibraryEntry {
  /** canonical key if present, e.g. "concrete_slab_m2" */
  key: string | null
  /** free-text description if present */
  description: string | null
  unit: string | null
  /** AUD ex-GST unit COST */
  rate: number
  trade_category_id: number | null
}

export interface RateMatchResult {
  items: EstimateLineItem[]
  matched: number
  unmatched: number
  /** scope the library did not cover — surfaced to the builder, not hidden */
  unmatched_items: Array<{ section: string; description: string; source_ref: string | null }>
}

// ─── Tokenising / unit normalisation ──────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'with', 'per', 'each', 'incl',
  'including', 'allowance', 'supply', 'install', 'new', 'existing', 'ea', 'lot',
])

function tokenise(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 1 && !STOPWORDS.has(t))
  )
}

export function normaliseUnit(unit: string | null): string | null {
  if (!unit) return null
  const u = unit.toLowerCase().replace(/\s+/g, '')
  if (['m2', 'sqm', 'm²', 'sm'].includes(u)) return 'm2'
  if (['m3', 'cum', 'm³'].includes(u)) return 'm3'
  if (['lm', 'm', 'lin.m', 'linm', 'lineal'].includes(u)) return 'lm'
  if (['ea', 'each', 'no', 'no.', 'item', 'unit'].includes(u)) return 'ea'
  if (['hr', 'hour', 'hrs'].includes(u)) return 'hr'
  if (['wk', 'week', 'wks'].includes(u)) return 'wk'
  if (['lot', 'ls', 'sum', 'item'].includes(u)) return 'lot'
  return u
}

function entryText(e: RateLibraryEntry): string {
  // Match against the description if present, else the key with underscores split.
  return e.description ?? (e.key ?? '').replace(/_/g, ' ')
}

// ─── Matching ─────────────────────────────────────────────────────────────────

/** Best library entry for a line item, or null. Requires: unit compatible (or
 *  the library entry has no unit), same trade category when the entry declares
 *  one, and a token-overlap score above threshold. */
export function bestRateMatch(
  item: EstimateLineItem,
  library: RateLibraryEntry[],
  minScore = 0.34
): RateLibraryEntry | null {
  const itemUnit = normaliseUnit(item.unit)
  const itemTokens = tokenise(item.description)
  if (itemTokens.size === 0) return null

  let best: RateLibraryEntry | null = null
  let bestScore = 0

  for (const entry of library) {
    // Trade category gate (only when the entry declares one)
    if (entry.trade_category_id != null && entry.trade_category_id !== item.trade_category_id) continue
    // Unit gate (only when both declare a unit)
    const entryUnit = normaliseUnit(entry.unit)
    if (itemUnit && entryUnit && itemUnit !== entryUnit) continue

    const entryTokens = tokenise(entryText(entry))
    if (entryTokens.size === 0) continue

    // Jaccard-ish: shared / smaller set size (rewards a specific library key
    // fully contained in a longer line description).
    let shared = 0
    for (const t of Array.from(itemTokens)) if (entryTokens.has(t)) shared++
    const score = shared / Math.min(itemTokens.size, entryTokens.size)

    if (score > bestScore) {
      bestScore = score
      best = entry
    }
  }

  return bestScore >= minScore ? best : null
}

/** Apply the library to the estimate. Only measured/allowance lines are
 *  repriced — pc_sum and provisional are client-selected / pending and must not
 *  be overridden by a rate library. Unmatched priceable lines are flagged. */
export function applyRateLibrary(items: EstimateLineItem[], library: RateLibraryEntry[]): RateMatchResult {
  let matched = 0
  let unmatched = 0
  const unmatched_items: RateMatchResult['unmatched_items'] = []

  const out = items.map((item): EstimateLineItem => {
    const priceable = item.basis === 'measured' || item.basis === 'allowance'
    if (!priceable) return { ...item, rate_unmatched: false }

    const hit = bestRateMatch(item, library)
    if (hit) {
      matched++
      const qty = item.quantity
      const total = qty !== null ? Math.round(qty * hit.rate * 100) / 100 : item.total
      return { ...item, rate: hit.rate, total, rate_unmatched: false }
    }

    // No library match — flag it, keep the market rate as a visible fallback.
    unmatched++
    unmatched_items.push({ section: item.section, description: item.description, source_ref: item.source_ref })
    return { ...item, rate_unmatched: true }
  })

  return { items: out, matched, unmatched, unmatched_items }
}

// ─── CSV parsing (tolerant) ───────────────────────────────────────────────────
// Accepts a header row with any of: key/code, description/item, unit/uom,
// rate/cost/price, trade/trade_category_id. Rows without a positive rate are
// skipped. Handles simple quoted fields.

export function parseRateLibraryCsv(csv: string): RateLibraryEntry[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().trim())
  const idx = (names: string[]): number => header.findIndex((h) => names.includes(h))

  const keyIdx = idx(['key', 'code', 'line_item_key', 'item_code'])
  const descIdx = idx(['description', 'item', 'desc', 'name'])
  const unitIdx = idx(['unit', 'uom', 'units'])
  const rateIdx = idx(['rate', 'cost', 'price', 'unit_rate', 'unit_cost'])
  const tradeIdx = idx(['trade', 'trade_category_id', 'category'])

  if (rateIdx === -1) return []

  const entries: RateLibraryEntry[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i])
    const rate = parseFloat((cols[rateIdx] ?? '').replace(/[^0-9.\-]/g, ''))
    if (!Number.isFinite(rate) || rate <= 0) continue

    const tradeRaw = tradeIdx >= 0 ? (cols[tradeIdx] ?? '').trim() : ''
    const tradeNum = tradeRaw ? parseInt(tradeRaw, 10) : NaN

    entries.push({
      key: keyIdx >= 0 ? (cols[keyIdx] ?? '').trim() || null : null,
      description: descIdx >= 0 ? (cols[descIdx] ?? '').trim() || null : null,
      unit: unitIdx >= 0 ? (cols[unitIdx] ?? '').trim() || null : null,
      rate,
      trade_category_id: Number.isInteger(tradeNum) && tradeNum >= 1 && tradeNum <= 13 ? tradeNum : null,
    })
  }
  return entries
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map((c) => c.trim())
}
