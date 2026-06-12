// ─── Estimation Memory Engine — demo data ────────────────────────────────────
// Simulates a builder with a solid history of completed residential projects.

import type {
  SimilarProject,
  ScopeHint,
  BuilderEstimationProfile,
  ProjectMetadata,
} from '@/lib/types/estimation.types'

// ─── Demo builder profile ─────────────────────────────────────────────────────

export const DEMO_BUILDER_PROFILE: BuilderEstimationProfile = {
  builder_id: '00000000-0000-0000-0000-000000000001',
  typical_margin_pct: 22,
  typical_contingency_pct: 5,
  finish_level: 'premium',
  avg_adjustment_pct: 4.2,
  adjustment_direction: 'increase',
  quotes_generated: 34,
  jobs_completed: 18,
  avg_quote_accuracy_pct: 91.4,
  preferred_suppliers: ['Midland Timber', 'Reece Plumbing', 'Sparky Direct'],
}

// ─── Demo historical project memory ──────────────────────────────────────────

export const DEMO_PROJECT_MEMORY: SimilarProject[] = [
  {
    id: 'mem-001',
    job_type: 'rear_extension',
    project_summary: 'Single-storey rear extension to a 1960s brick veneer home in St Kilda. Open-plan kitchen/living addition, 72sqm, 1 wet area, premium finishes.',
    floor_area_m2: 72,
    storeys: 1,
    wet_areas: 1,
    finish_level: 'premium',
    region: 'VIC',
    suburb: 'St Kilda',
    quoted_cost: 198400,
    final_cost: 211200,
    quoted_margin_pct: 22,
    final_margin_pct: 19.8,
    completed_at: new Date(Date.now() - 8 * 30 * 24 * 60 * 60 * 1000).toISOString(),
    similarity_score: 94,
    similarity_reasons: ['Same job type', 'Similar floor area', 'Same state', 'Same finish level'],
  },
  {
    id: 'mem-002',
    job_type: 'rear_extension',
    project_summary: 'Rear extension and kitchen renovation in Northcote. Timber-frame addition 65sqm, stone benchtops, integrated appliances. 2 wet areas.',
    floor_area_m2: 65,
    storeys: 1,
    wet_areas: 2,
    finish_level: 'premium',
    region: 'VIC',
    suburb: 'Northcote',
    quoted_cost: 182000,
    final_cost: 196500,
    quoted_margin_pct: 21,
    final_margin_pct: 18.4,
    completed_at: new Date(Date.now() - 14 * 30 * 24 * 60 * 60 * 1000).toISOString(),
    similarity_score: 91,
    similarity_reasons: ['Same job type', 'Similar floor area (−12%)', 'Same state', 'Same finish level'],
  },
  {
    id: 'mem-003',
    job_type: 'rear_extension',
    project_summary: 'Open-plan ground floor extension, Cronulla NSW. 88sqm, alfresco integration, polished concrete floors, 1 wet area.',
    floor_area_m2: 88,
    storeys: 1,
    wet_areas: 1,
    finish_level: 'premium',
    region: 'NSW',
    suburb: 'Cronulla',
    quoted_cost: 228000,
    final_cost: 241000,
    quoted_margin_pct: 23,
    final_margin_pct: 20.5,
    completed_at: new Date(Date.now() - 22 * 30 * 24 * 60 * 60 * 1000).toISOString(),
    similarity_score: 88,
    similarity_reasons: ['Same job type', 'Similar floor area (+17%)', 'Different state', 'Same finish level'],
  },
  {
    id: 'mem-004',
    job_type: 'full_renovation',
    project_summary: 'Full home renovation Brighton. 3 bed, 2 bath, 210sqm. All wet areas, kitchen, flooring, painting. Occupied during works.',
    floor_area_m2: 210,
    storeys: 1,
    wet_areas: 2,
    finish_level: 'premium',
    region: 'VIC',
    suburb: 'Brighton',
    quoted_cost: 312000,
    final_cost: 338000,
    quoted_margin_pct: 22,
    final_margin_pct: 19.1,
    completed_at: new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000).toISOString(),
    similarity_score: 83,
    similarity_reasons: ['Different job type', 'Larger floor area', 'Same state', 'Same finish level'],
  },
  {
    id: 'mem-005',
    job_type: 'rear_extension',
    project_summary: 'Timber-frame rear extension 78sqm, Port Melbourne. Open plan living, 1 bathroom addition, blackbutt flooring throughout.',
    floor_area_m2: 78,
    storeys: 1,
    wet_areas: 1,
    finish_level: 'standard',
    region: 'VIC',
    suburb: 'Port Melbourne',
    quoted_cost: 165000,
    final_cost: 172000,
    quoted_margin_pct: 20,
    final_margin_pct: 18.8,
    completed_at: new Date(Date.now() - 18 * 30 * 24 * 60 * 60 * 1000).toISOString(),
    similarity_score: 80,
    similarity_reasons: ['Same job type', 'Similar floor area (+4%)', 'Same state', 'Lower finish level'],
  },
]

// ─── Demo scope hints ─────────────────────────────────────────────────────────

export const DEMO_SCOPE_HINTS: ScopeHint[] = [
  {
    description: 'Demolition of existing rear wall & weatherproofing',
    trade_category_id: 1,
    confidence: 90,
    reason: 'All rear extensions require opening the existing building envelope.',
    typical_cost_range: '$3,500–$6,000',
  },
  {
    description: 'Temporary weather protection during works',
    trade_category_id: 1,
    confidence: 85,
    reason: 'Required while the rear wall is open to the elements.',
    typical_cost_range: '$800–$1,800',
  },
  {
    description: 'Structural tie-in to existing building',
    trade_category_id: 3,
    confidence: 88,
    reason: 'New framing must be engineered to tie into the existing roof and wall structure.',
    typical_cost_range: '$2,000–$4,500',
  },
  {
    description: 'Existing drainage relocation',
    trade_category_id: 11,
    confidence: 75,
    reason: 'Stormwater and sewer points commonly fall within the extension footprint.',
    typical_cost_range: '$1,200–$3,000',
  },
]

// ─── Scope hints by job type ──────────────────────────────────────────────────

export const SCOPE_HINTS_BY_TYPE: Record<string, ScopeHint[]> = {
  rear_extension: DEMO_SCOPE_HINTS,
  side_extension: DEMO_SCOPE_HINTS,
  bathroom_reno: [
    {
      description: 'Full waterproofing membrane — floor & walls to 1800mm',
      trade_category_id: 2,
      confidence: 98,
      reason: 'BCA mandatory for all wet areas.',
      typical_cost_range: '$1,800–$3,200',
    },
    {
      description: 'Tile removal & substrate preparation',
      trade_category_id: 1,
      confidence: 90,
      reason: 'Existing tiles must be removed before waterproofing can be applied.',
      typical_cost_range: '$600–$1,500',
    },
    {
      description: 'Floor drainage adjustment to new layout',
      trade_category_id: 11,
      confidence: 80,
      reason: 'Drain position commonly changes with a new bathroom layout.',
      typical_cost_range: '$800–$2,000',
    },
  ],
  kitchen_reno: [
    {
      description: 'Plumbing rough-in changes for new layout',
      trade_category_id: 11,
      confidence: 85,
      reason: 'Sink and dishwasher positions commonly move in a kitchen renovation.',
      typical_cost_range: '$900–$2,500',
    },
    {
      description: 'Dedicated electrical circuits for appliances',
      trade_category_id: 12,
      confidence: 88,
      reason: 'Modern kitchens require separate circuits for oven, dishwasher, and fridge.',
      typical_cost_range: '$1,200–$2,800',
    },
    {
      description: 'External rangehood ducting',
      trade_category_id: 12,
      confidence: 80,
      reason: 'Required unless recirculating model — penetration through wall or roof.',
      typical_cost_range: '$600–$1,400',
    },
  ],
  double_storey: [
    {
      description: 'Structural engineering fees',
      trade_category_id: 1,
      confidence: 98,
      reason: 'Mandatory certification for all second-storey work.',
      typical_cost_range: '$3,500–$6,000',
    },
    {
      description: 'Existing footing / structure strengthening',
      trade_category_id: 3,
      confidence: 78,
      reason: 'Original footings often need upgrading to carry the additional load.',
      typical_cost_range: '$8,000–$25,000',
    },
    {
      description: 'Stair construction',
      trade_category_id: 3,
      confidence: 95,
      reason: 'Internal stair access always required for a second storey.',
      typical_cost_range: '$12,000–$28,000',
    },
  ],
}

// ─── Demo project metadata (for a rear extension) ─────────────────────────────

export const DEMO_PROJECT_METADATA: ProjectMetadata = {
  job_type: 'rear_extension',
  renovation_type: 'extension',
  project_summary: 'Single-storey rear extension, approximately 75–85sqm, open-plan kitchen and living, 1 wet area, timber frame, premium finishes.',
  floor_area_m2: 80,
  storeys: 1,
  wet_areas: 1,
  bedrooms: null,
  finish_level: 'premium',
  construction_type: 'timber_frame',
  region: 'VIC',
  suburb: null,
}

// ─── Demo trade variance data (for explainability) ────────────────────────────

export interface DemoTradeVariance {
  trade_category_id: number
  trade_category_name: string
  avg_variance_pct: number  // positive = historically over-estimate
  sample_count: number
  note: string
}

export const DEMO_TRADE_VARIANCES: DemoTradeVariance[] = [
  { trade_category_id: 12, trade_category_name: 'Electrical',          avg_variance_pct: +14.2, sample_count: 12, note: 'Electricals consistently run over — typically more power points and circuits required than initially scoped.' },
  { trade_category_id: 11, trade_category_name: 'Plumbing',            avg_variance_pct: +8.7,  sample_count: 11, note: 'Hidden drainage issues commonly discovered on-site.' },
  { trade_category_id: 1,  trade_category_name: 'Earthworks & Site Prep', avg_variance_pct: +11.3, sample_count: 8, note: 'Demolition and site preparation costs frequently exceed estimate.' },
  { trade_category_id: 3,  trade_category_name: 'Framing & Structural', avg_variance_pct: +2.1,  sample_count: 14, note: 'Framing is historically accurate — good visibility from plans.' },
  { trade_category_id: 10, trade_category_name: 'Painting',            avg_variance_pct: -1.8,  sample_count: 16, note: 'Painting estimates are slightly conservative — often comes in under.' },
]
