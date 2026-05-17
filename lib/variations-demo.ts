// ─── Shared demo state for variation routes ────────────────────────────────────
// This module holds the in-memory demo data so it can be shared between
// the GET and POST handlers without exporting from a Next.js route file.

export interface DemoVariation {
  id: string
  job_id: string
  job_address: string
  builder_id: string
  title: string
  description: string
  amount: number
  status: 'draft' | 'pending' | 'approved' | 'rejected'
  created_at: string // ISO for internal use
  created_display: string // "2 days ago"
  approved_at: string | null
  approved_by: string | null
  variation_ref?: string
  labour_cost?: number
  materials_cost?: number
  submitted_by?: string
}

export const DEMO_VARIATIONS: DemoVariation[] = [
  {
    id: 'var-001',
    job_id: '00000000-0000-0000-0000-000000000010',
    job_address: '14 Merri St, Fitzroy VIC 3065',
    builder_id: '00000000-0000-0000-0000-000000000001',
    title: 'Upgrade kitchen benchtop to 40mm Caesarstone',
    description:
      'Client requested upgrade from standard laminate to 40mm Caesarstone benchtop in kitchen. Includes removal of existing laminate, supply and install of Caesarstone, and updated silicone sealing.',
    amount: 3200,
    status: 'pending',
    created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    created_display: '2 days ago',
    approved_at: null,
    approved_by: null,
    variation_ref: 'VAR-001',
    labour_cost: 800,
    materials_cost: 2400,
    submitted_by: 'Tom Chen',
  },
  {
    id: 'var-002',
    job_id: '00000000-0000-0000-0000-000000000010',
    job_address: '14 Merri St, Fitzroy VIC 3065',
    builder_id: '00000000-0000-0000-0000-000000000001',
    title: 'Add extra GPO points to living room',
    description:
      'Client requested 4 additional double GPO power points in the living room — 2 on the east wall, 2 on the south wall. Includes conduit, cabling, and switchboard connection.',
    amount: 680,
    status: 'pending',
    created_at: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    created_display: '4 days ago',
    approved_at: null,
    approved_by: null,
    variation_ref: 'VAR-002',
    labour_cost: 680,
    materials_cost: 0,
    submitted_by: 'Tom Chen',
  },
]

// In-memory resolution state (mutated by the resolve endpoint)
export const demoVariationState = new Map<
  string,
  { status: string; approved_at?: string; approved_by?: string }
>()
