// ─── Shared demo state for assumption routes ──────────────────────────────────
// This module holds the in-memory demo data so it can be shared between
// the GET and POST handlers without exporting from a Next.js route file.

export interface AssumptionItem {
  id: string
  line_item_id: string | null
  description: string
  gate: 1 | 2 | 3
  current_quantity: number | null
  current_unit: string | null
  current_rate: number | null
  trade_category: string
  resolution_type: 'unresolved' | 'accepted' | 'adjusted' | 'excluded'
}

export const DEMO_ASSUMPTIONS: AssumptionItem[] = [
  {
    id: 'demo-assumption-1',
    line_item_id: 'demo-line-1',
    description: 'GPO points — living areas',
    gate: 1,
    current_quantity: 14,
    current_unit: null, // Gate 1: no unit
    current_rate: 85,
    trade_category: 'Electrical',
    resolution_type: 'unresolved',
  },
  {
    id: 'demo-assumption-2',
    line_item_id: 'demo-line-2',
    description: 'Plasterboard — feature wall',
    gate: 2,
    current_quantity: 22.5,
    current_unit: 'sqm',
    current_rate: 45,
    trade_category: 'Internal Linings',
    resolution_type: 'unresolved', // Gate 2: quantity but no dimensions string
  },
  {
    id: 'demo-assumption-3',
    line_item_id: 'demo-line-3',
    description: 'Scaffolding — perimeter',
    gate: 3,
    current_quantity: 0,
    current_unit: 'weeks',
    current_rate: 1200,
    trade_category: 'Preliminaries',
    resolution_type: 'unresolved', // Gate 3: zero quantity → auto-excluded but shown for review
  },
]

export const demoResolutionState = new Map<
  string,
  {
    resolution_type: 'unresolved' | 'accepted' | 'adjusted' | 'excluded'
    adjusted_quantity?: number
    adjusted_unit?: string
  }
>()
