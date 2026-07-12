// ─── Canonical trade taxonomy ──────────────────────────────────────────────────
// The single source of truth for WorkA's 13 trade categories. Mirrors the
// DB-locked `trade_categories` table (migration 001, sort_order 1-13 — never
// renumbered or renamed). Every code path that assigns a `trade_category_id`
// must use this list, not a re-invented numbering.
//
// The `supabase/functions/smooth-responder` edge function runs in Deno and
// cannot import this file directly (separate deploy target) — its copy of
// this list must be kept byte-for-byte identical. Everything on the Next.js
// side (Node) must import from here.

export interface TradeCategoryDef {
  id: number
  name: string
}

export const TRADE_CATEGORIES: readonly TradeCategoryDef[] = [
  { id: 1, name: 'Site Works & Concrete' },
  { id: 2, name: 'Framing' },
  { id: 3, name: 'Roofing' },
  { id: 4, name: 'External Cladding' },
  { id: 5, name: 'Insulation' },
  { id: 6, name: 'Internal Linings' },
  { id: 7, name: 'Fit-out Carpentry' },
  { id: 8, name: 'Cabinetry' },
  { id: 9, name: 'Paint' },
  { id: 10, name: 'Flooring' },
  { id: 11, name: 'Fixtures & Tapware' },
  { id: 12, name: 'Electrical' },
  { id: 13, name: 'Preliminaries' },
] as const

export function tradeCategoryName(id: number): string {
  return TRADE_CATEGORIES.find((c) => c.id === id)?.name ?? `Trade ${id}`
}

export function isValidTradeCategoryId(id: number): boolean {
  return id >= 1 && id <= 13 && Number.isInteger(id)
}
