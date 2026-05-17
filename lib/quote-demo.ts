// ─── Shared demo state for quote routes ────────────────────────────────────────
// This module holds the in-memory demo data so it can be shared between
// the GET handler and any future mutation routes without exporting from a
// Next.js route file.

export interface DemoQuoteLineItem {
  id: string
  quote_id: string
  trade_category_id: number
  trade_category_name: string
  description: string
  quantity: number | null
  unit: string | null
  rate: number | null
  total: number | null
  confidence: number // 0-100
  dimensions_string: string | null
  is_assumption: boolean
  assumption_status: 'unresolved' | 'accepted' | 'adjusted' | 'excluded' | null
}

export interface DemoQuote {
  id: string
  job_id: string
  job_address: string
  builder_id: string
  status: 'draft' | 'pending_review' | 'sent' | 'approved' | 'rejected'
  total_cost: number
  margin_pct: number
  confidence_score: number // weighted toward lowest line item
  version: number
  created_at: string
}

// ─── Demo quote ───────────────────────────────────────────────────────────────

export const DEMO_QUOTE: DemoQuote = {
  id: 'demo-quote-id',
  job_id: 'demo-job-id',
  job_address: '52 Bendigo St, Brunswick VIC 3056',
  builder_id: '00000000-0000-0000-0000-000000000001',
  status: 'pending_review',
  total_cost: 127500,
  margin_pct: 18,
  // Confidence is weighted toward the LOWEST line item — one bad extraction
  // cannot be hidden. The feature wall plasterboard at 45% drives the score.
  confidence_score: 45,
  version: 1,
  created_at: new Date().toISOString(),
}

// ─── Demo line items ──────────────────────────────────────────────────────────
// All 13 trade categories. Realistic Australian residential renovation.

export const DEMO_LINE_ITEMS: DemoQuoteLineItem[] = [
  // ── 1. Site Works & Concrete ──────────────────────────────────────────────
  {
    id: 'li-01-01',
    quote_id: 'demo-quote-id',
    trade_category_id: 1,
    trade_category_name: 'Site Works & Concrete',
    description: 'Excavation & earthworks',
    quantity: 45,
    unit: 'm³',
    rate: 85,
    total: 3825,
    confidence: 92,
    dimensions_string: '9m × 5m × 1m avg',
    is_assumption: false,
    assumption_status: null,
  },
  {
    id: 'li-01-02',
    quote_id: 'demo-quote-id',
    trade_category_id: 1,
    trade_category_name: 'Site Works & Concrete',
    description: 'Concrete slab',
    quantity: 72,
    unit: 'sqm',
    rate: 145,
    total: 10440,
    confidence: 88,
    dimensions_string: '9m × 8m',
    is_assumption: false,
    assumption_status: null,
  },

  // ── 2. Framing ────────────────────────────────────────────────────────────
  {
    id: 'li-02-01',
    quote_id: 'demo-quote-id',
    trade_category_id: 2,
    trade_category_name: 'Framing',
    description: 'Wall framing',
    quantity: 210,
    unit: 'lm',
    rate: 38,
    total: 7980,
    confidence: 85,
    dimensions_string: 'perimeter + internal walls',
    is_assumption: false,
    assumption_status: null,
  },
  {
    id: 'li-02-02',
    quote_id: 'demo-quote-id',
    trade_category_id: 2,
    trade_category_name: 'Framing',
    description: 'Roof framing',
    quantity: 95,
    unit: 'sqm',
    rate: 95,
    total: 9025,
    confidence: 78,
    dimensions_string: '9m × 8m hip',
    is_assumption: false,
    assumption_status: null,
  },

  // ── 3. Roofing ────────────────────────────────────────────────────────────
  {
    id: 'li-03-01',
    quote_id: 'demo-quote-id',
    trade_category_id: 3,
    trade_category_name: 'Roofing',
    description: 'Colorbond roof sheeting',
    quantity: 105,
    unit: 'sqm',
    rate: 85,
    total: 8925,
    confidence: 90,
    dimensions_string: '9m × 8m + 15% waste',
    is_assumption: false,
    assumption_status: null,
  },

  // ── 4. External Cladding ──────────────────────────────────────────────────
  {
    id: 'li-04-01',
    quote_id: 'demo-quote-id',
    trade_category_id: 4,
    trade_category_name: 'External Cladding',
    description: 'Brick veneer',
    quantity: 180,
    unit: 'sqm',
    rate: 95,
    total: 17100,
    confidence: 82,
    dimensions_string: 'perimeter walls',
    is_assumption: false,
    assumption_status: null,
  },

  // ── 5. Insulation ─────────────────────────────────────────────────────────
  {
    id: 'li-05-01',
    quote_id: 'demo-quote-id',
    trade_category_id: 5,
    trade_category_name: 'Insulation',
    description: 'Wall batts R2.5',
    quantity: 145,
    unit: 'sqm',
    rate: 12,
    total: 1740,
    confidence: 95,
    dimensions_string: 'wall area',
    is_assumption: false,
    assumption_status: null,
  },
  {
    id: 'li-05-02',
    quote_id: 'demo-quote-id',
    trade_category_id: 5,
    trade_category_name: 'Insulation',
    description: 'Ceiling batts R4.0',
    quantity: 72,
    unit: 'sqm',
    rate: 18,
    total: 1296,
    confidence: 95,
    dimensions_string: 'ceiling area',
    is_assumption: false,
    assumption_status: null,
  },

  // ── 6. Internal Linings ───────────────────────────────────────────────────
  {
    id: 'li-06-01',
    quote_id: 'demo-quote-id',
    trade_category_id: 6,
    trade_category_name: 'Internal Linings',
    description: 'Plasterboard walls & ceilings',
    quantity: 380,
    unit: 'sqm',
    rate: 28,
    total: 10640,
    confidence: 86,
    dimensions_string: 'wall+ceiling calc',
    is_assumption: false,
    assumption_status: null,
  },
  {
    id: 'li-06-02',
    quote_id: 'demo-quote-id',
    trade_category_id: 6,
    trade_category_name: 'Internal Linings',
    // Gate 2: quantity extracted but no dimensions_string — confidence 45
    description: 'Plasterboard — feature wall',
    quantity: 22.5,
    unit: 'sqm',
    rate: 45,
    total: 1013,
    confidence: 45,
    dimensions_string: null,
    is_assumption: true,
    assumption_status: 'unresolved',
  },

  // ── 7. Fit-out Carpentry ──────────────────────────────────────────────────
  {
    id: 'li-07-01',
    quote_id: 'demo-quote-id',
    trade_category_id: 7,
    trade_category_name: 'Fit-out Carpentry',
    description: 'Doors & hardware',
    quantity: 8,
    unit: 'each',
    rate: 420,
    total: 3360,
    confidence: 88,
    dimensions_string: 'door schedule',
    is_assumption: false,
    assumption_status: null,
  },
  {
    id: 'li-07-02',
    quote_id: 'demo-quote-id',
    trade_category_id: 7,
    trade_category_name: 'Fit-out Carpentry',
    description: 'Skirtings & architraves',
    quantity: 145,
    unit: 'lm',
    rate: 22,
    total: 3190,
    confidence: 82,
    dimensions_string: 'perimeter rooms',
    is_assumption: false,
    assumption_status: null,
  },

  // ── 8. Cabinetry ──────────────────────────────────────────────────────────
  {
    id: 'li-08-01',
    quote_id: 'demo-quote-id',
    trade_category_id: 8,
    trade_category_name: 'Cabinetry',
    description: 'Kitchen cabinetry',
    quantity: 1,
    unit: 'lot',
    rate: 14500,
    total: 14500,
    confidence: 72,
    dimensions_string: null, // no detailed schedule
    is_assumption: false,
    assumption_status: null,
  },

  // ── 9. Paint ──────────────────────────────────────────────────────────────
  {
    id: 'li-09-01',
    quote_id: 'demo-quote-id',
    trade_category_id: 9,
    trade_category_name: 'Paint',
    description: 'Internal paint',
    quantity: 380,
    unit: 'sqm',
    rate: 18,
    total: 6840,
    confidence: 90,
    dimensions_string: 'wall+ceiling',
    is_assumption: false,
    assumption_status: null,
  },

  // ── 10. Flooring ──────────────────────────────────────────────────────────
  {
    id: 'li-10-01',
    quote_id: 'demo-quote-id',
    trade_category_id: 10,
    trade_category_name: 'Flooring',
    description: 'Tiles — wet areas',
    quantity: 48,
    unit: 'sqm',
    rate: 95,
    total: 4560,
    confidence: 85,
    dimensions_string: 'bathroom+laundry',
    is_assumption: false,
    assumption_status: null,
  },
  {
    id: 'li-10-02',
    quote_id: 'demo-quote-id',
    trade_category_id: 10,
    trade_category_name: 'Flooring',
    description: 'Timber flooring',
    quantity: 58,
    unit: 'sqm',
    rate: 110,
    total: 6380,
    confidence: 78,
    dimensions_string: 'living+beds',
    is_assumption: false,
    assumption_status: null,
  },

  // ── 11. Fixtures & Tapware ────────────────────────────────────────────────
  {
    id: 'li-11-01',
    quote_id: 'demo-quote-id',
    trade_category_id: 11,
    trade_category_name: 'Fixtures & Tapware',
    description: 'Bathroom fixtures',
    quantity: 1,
    unit: 'lot',
    rate: 4200,
    total: 4200,
    confidence: 68,
    dimensions_string: null,
    is_assumption: false,
    assumption_status: null,
  },

  // ── 12. Electrical ────────────────────────────────────────────────────────
  {
    id: 'li-12-01',
    quote_id: 'demo-quote-id',
    trade_category_id: 12,
    trade_category_name: 'Electrical',
    // Gate 1: no unit in original — confidence 0, unresolved assumption
    description: 'GPO points — living areas',
    quantity: 14,
    unit: null,
    rate: null,
    total: null,
    confidence: 0,
    dimensions_string: null,
    is_assumption: true,
    assumption_status: 'unresolved',
  },
  {
    id: 'li-12-02',
    quote_id: 'demo-quote-id',
    trade_category_id: 12,
    trade_category_name: 'Electrical',
    description: 'General electrical',
    quantity: 1,
    unit: 'lot',
    rate: 8500,
    total: 8500,
    confidence: 74,
    dimensions_string: null,
    is_assumption: false,
    assumption_status: null,
  },

  // ── 13. Preliminaries ─────────────────────────────────────────────────────
  {
    id: 'li-13-01',
    quote_id: 'demo-quote-id',
    trade_category_id: 13,
    trade_category_name: 'Preliminaries',
    description: 'Permits & council fees',
    quantity: 1,
    unit: 'lot',
    rate: 3200,
    total: 3200,
    confidence: 95,
    dimensions_string: null,
    is_assumption: false,
    assumption_status: null,
  },
  {
    id: 'li-13-02',
    quote_id: 'demo-quote-id',
    trade_category_id: 13,
    trade_category_name: 'Preliminaries',
    // Gate 3: zero quantity → auto-excluded
    description: 'Scaffolding — perimeter',
    quantity: 0,
    unit: 'weeks',
    rate: 1200,
    total: 0,
    confidence: 0,
    dimensions_string: null,
    is_assumption: true,
    assumption_status: 'excluded',
  },
  {
    id: 'li-13-03',
    quote_id: 'demo-quote-id',
    trade_category_id: 13,
    trade_category_name: 'Preliminaries',
    description: 'Site insurance',
    quantity: 1,
    unit: 'lot',
    rate: 1800,
    total: 1800,
    confidence: 90,
    dimensions_string: null,
    is_assumption: false,
    assumption_status: null,
  },
]
