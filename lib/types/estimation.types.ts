// ─── Estimation Memory Engine — shared types ──────────────────────────────────

export type FinishLevel = 'budget' | 'standard' | 'premium' | 'luxury'
export type RenovationType = 'extension' | 'renovation' | 'new_build' | 'addition' | 'alteration' | 'knockdown_rebuild'
export type JobType =
  | 'rear_extension'
  | 'side_extension'
  | 'bathroom_reno'
  | 'kitchen_reno'
  | 'double_storey'
  | 'granny_flat'
  | 'new_build'
  | 'knockdown_rebuild'
  | 'full_renovation'
  | 'deck_pergola'
  | 'other'

export interface ProjectMetadata {
  job_type: JobType | null
  renovation_type: RenovationType | null
  project_summary: string
  floor_area_m2: number | null
  storeys: number | null
  wet_areas: number | null
  bedrooms: number | null
  finish_level: FinishLevel | null
  construction_type: string | null
  region: string | null
  suburb: string | null
}

export interface SimilarProject {
  id: string
  job_type: JobType | null
  project_summary: string
  floor_area_m2: number | null
  storeys: number | null
  wet_areas: number | null
  finish_level: FinishLevel | null
  region: string | null
  suburb: string | null
  quoted_cost: number | null
  final_cost: number | null
  quoted_margin_pct: number | null
  final_margin_pct: number | null
  completed_at: string | null
  similarity_score: number   // 0–100
  similarity_reasons: string[]
}

export interface ScopeHint {
  description: string
  trade_category_id: number
  confidence: number  // 0–100
  reason: string
  typical_cost_range?: string
}

export interface BuilderEstimationProfile {
  builder_id: string
  typical_margin_pct: number
  typical_contingency_pct: number
  finish_level: FinishLevel
  avg_adjustment_pct: number | null
  adjustment_direction: 'increase' | 'decrease' | 'neutral' | null
  quotes_generated: number
  jobs_completed: number
  avg_quote_accuracy_pct: number | null
  preferred_suppliers: string[]
}

export interface EstimationContext {
  similar_projects: SimilarProject[]
  scope_hints: ScopeHint[]
  builder_profile: BuilderEstimationProfile
  project_metadata: ProjectMetadata
}

export interface TradeExplainability {
  trade_category_id: number
  trade_category_name: string
  estimated_cost: number
  confidence: number  // 0–100
  similar_project_range: string | null   // e.g. "$12,000–$18,000 across 4 similar projects"
  historical_accuracy: string | null     // e.g. "Electricals historically run 12% over estimate"
  key_drivers: string[]                  // e.g. ["42 outlets detected", "Sydney pricing"]
}

export interface CostReconciliationEntry {
  trade_category_id: number
  trade_category_name: string
  estimated_cost: number
  actual_cost: number | null
  variance_amount: number | null
  variance_pct: number | null
}
