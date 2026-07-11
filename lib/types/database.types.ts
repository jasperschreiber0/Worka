/**
 * WorkA database types — auto-matched to 001_initial_schema.sql
 * Update this file whenever a migration changes table structure.
 */

// ─── Enumerations ────────────────────────────────────────────────────────────

export type AustralianState = 'NSW' | 'VIC' | 'QLD' | 'WA' | 'SA' | 'TAS' | 'ACT' | 'NT'

export type BuilderPlan = 'starter' | 'builder' | 'business'

export type WorkerStatus = 'invited' | 'active' | 'inactive'

export type JobStatus = 'quoting' | 'quoted' | 'active' | 'complete' | 'archived'

export type QuoteStatus = 'draft' | 'pending_review' | 'sent' | 'approved' | 'rejected'

export type AssumptionStatus = 'unresolved' | 'accepted' | 'adjusted' | 'excluded'

export type VariationStatus = 'draft' | 'pending' | 'approved' | 'rejected'

export type InvoiceStatus = 'draft' | 'sent' | 'overdue' | 'paid'

export type CommunicationDirection = 'inbound' | 'outbound'

export type CommunicationChannel = 'email' | 'sms' | 'chat'

export type FileType = 'pdf' | 'image' | 'dwg' | 'other'

export type FileIntakeStatus = 'uploaded' | 'queued' | 'processing' | 'extracted' | 'failed'

export type ResolutionType = 'accepted' | 'adjusted' | 'excluded'

// ─── Row types (mirrors DB columns exactly) ──────────────────────────────────

export interface Builder {
  id: string
  email: string
  name: string
  business_name: string | null
  abn: string | null
  state: AustralianState | null
  plan: BuilderPlan
  stripe_customer_id: string | null
  created_at: string
}

export interface Worker {
  id: string
  builder_id: string
  name: string
  role: string
  email: string | null
  phone: string | null
  status: WorkerStatus
  invite_token: string | null
  created_at: string
}

export interface Client {
  id: string
  builder_id: string
  name: string
  email: string | null
  phone: string | null
  created_at: string
}

export interface TradeCategory {
  id: number
  sort_order: number
  name: string
  typical_line_items: string[]
}

export interface Job {
  id: string
  builder_id: string
  client_id: string | null
  address: string
  status: JobStatus
  job_type: string | null
  notes: string | null
  budget_estimate: number | null
  scope_notes: string | null
  quote_deadline: string | null   // ISO date: "YYYY-MM-DD"
  client_deadline: string | null  // ISO date: "YYYY-MM-DD"
  created_at: string
  updated_at: string
}

export interface StateChange {
  status: 'saved' | 'found' | 'warning' | 'blocked' | 'info'
  label: string
}

export interface Quote {
  id: string
  job_id: string
  builder_id: string
  status: QuoteStatus
  total_cost: number | null
  margin_pct: number | null
  /** Weighted toward lowest line item confidence */
  confidence_score: number | null
  version: number
  created_at: string
  sent_at: string | null
  approved_at: string | null
  /** Migration 014 */
  contingency_pct: number | null
  gst_pct: number | null
}

export type PricingType = 'measured' | 'pc_allowance' | 'provisional_sum'

export interface QuoteLineItem {
  id: string
  quote_id: string
  trade_category_id: number
  description: string
  quantity: number | null
  unit: string | null
  rate: number | null
  total: number | null
  /** 0–100 */
  confidence: number | null
  /** e.g. "12.5m × 8.4m" */
  dimensions_string: string | null
  is_assumption: boolean
  assumption_status: AssumptionStatus | null
  created_at: string
  /** Cost split columns */
  labour_cost: number | null
  material_cost: number | null
  subcontract_cost: number | null
  plant_cost: number | null
  /** measured | pc_allowance | provisional_sum */
  pricing_type: PricingType
  /** Drawing reference e.g. "A3.1", "SK-04" */
  source_ref: string | null
  /** Per-line margin rate (0–1). PS items always 0. */
  margin_pct: number
  /** Migration 014 */
  pricing_basis: 'measured' | 'inferred' | 'allowance' | null
  notes: string | null
}

export interface CostRate {
  id: string
  trade_category_id: number
  line_item_key: string
  description: string
  unit: string
  rate: number
  /** null = national default */
  state: AustralianState | null
  is_default: boolean
  created_at: string
}

export interface BuilderLearnedRate {
  id: string
  builder_id: string
  line_item_key: string
  rate: number
  unit: string
  sample_count: number
  updated_at: string
}

export interface BuilderRatePreference {
  id: string
  builder_id: string
  line_item_key: string
  rate: number
  unit: string
  set_at: string
}

export interface BuilderSupplierRate {
  id: string
  builder_id: string
  supplier_name: string
  line_item_key: string
  rate: number
  unit: string
  imported_at: string
}

export interface NetworkRateAggregate {
  id: string
  line_item_key: string
  state: AustralianState | null
  rate_p25: number | null
  rate_p50: number | null
  rate_p75: number | null
  sample_count: number
  updated_at: string
}

export interface Variation {
  id: string
  job_id: string
  builder_id: string
  title: string
  description: string
  amount: number | null
  status: VariationStatus
  created_at: string
  approved_at: string | null
  approved_by: string | null
  /** Migration 006 */
  variation_ref: string | null
  labour_cost: number | null
  materials_cost: number | null
  submitted_by: string | null
  /** Migration 018 — client-facing share link auth */
  share_token_hash: string | null
  share_token_expires_at: string | null
}

export interface Invoice {
  id: string
  job_id: string
  builder_id: string
  amount: number
  status: InvoiceStatus
  due_date: string | null
  sent_at: string | null
  paid_at: string | null
  created_at: string
}

export interface CommunicationHistory {
  id: string
  job_id: string | null
  builder_id: string
  direction: CommunicationDirection
  channel: CommunicationChannel
  subject: string | null
  body: string
  from_address: string | null
  to_address: string | null
  timestamp: string
  linked_variation_id: string | null
  linked_invoice_id: string | null
}

export interface File {
  id: string
  job_id: string | null
  quote_id: string | null
  builder_id: string
  storage_path: string
  filename: string
  file_type: FileType
  intake_status: FileIntakeStatus
  failure_stage: string | null
  failure_reason: string | null
  extracted_text_length: number | null
  page_count: number | null
  line_item_count: number | null
  processing_time_ms: number | null
  pipeline_stage: string | null
  intake_result: Record<string, unknown> | null
  intake_stage: string | null
  intake_pct: number | null
  intake_assumption_count: number | null
  created_at: string
}

export interface Assumption {
  id: string
  quote_id: string
  line_item_id: string | null
  description: string
  resolution_type: ResolutionType | null
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
}

// ─── Job workers, milestones, invoicing, proof (migrations 005, 007) ─────────

export interface JobWorker {
  id: string
  job_id: string
  worker_id: string
  assigned_at: string
  assigned_by: string | null
}

export interface JobMilestone {
  id: string
  job_id: string
  builder_id: string
  title: string
  description: string | null
  due_date: string | null // ISO date
  completed_at: string | null
  sort_order: number
  created_at: string
}

export interface InvoiceScheduleEntry {
  id: string
  job_id: string
  builder_id: string
  label: string
  percentage: number
  amount: number
  due_trigger: string
  invoice_id: string | null
  created_at: string
}

export interface ProofEventRow {
  id: string
  job_id: string
  builder_id: string
  event_type: string
  description: string
  metadata: Record<string, unknown> | null
  created_at: string
}

// ─── Estimation Memory Engine tables (migration 011) ─────────────────────────
// App-facing shapes for these tables live in lib/types/estimation.types.ts —
// these mirror the raw DB columns instead.

export interface TradeSubcategory {
  id: string
  trade_category_id: number
  code: string
  name: string
  typical_unit: string | null
  sort_order: number
}

export interface ProjectMemoryRow {
  id: string
  builder_id: string
  job_id: string | null
  quote_id: string | null
  project_summary: string | null
  job_type: string | null
  renovation_type: string | null
  floor_area_m2: number | null
  storeys: number | null
  wet_areas: number | null
  bedrooms: number | null
  finish_level: string | null
  construction_type: string | null
  region: string | null
  suburb: string | null
  quoted_cost: number | null
  final_cost: number | null
  quoted_margin_pct: number | null
  final_margin_pct: number | null
  trade_breakdown: Record<string, { estimated: number; actual: number }> | null
  scope_hits: unknown[] | null
  scope_misses: unknown[] | null
  /** pgvector(1536) — nullable until an embedding service is wired up */
  embedding: number[] | null
  status: 'draft' | 'quoted' | 'active' | 'completed'
  created_at: string
  completed_at: string | null
}

export interface CostReconciliation {
  id: string
  project_memory_id: string
  builder_id: string
  trade_category_id: number
  estimated_cost: number
  actual_cost: number | null
  /** Generated column: actual_cost - estimated_cost */
  variance_amount: number | null
  job_type: string | null
  region: string | null
  finish_level: string | null
  recorded_at: string | null
  created_at: string
}

export interface BuilderEstimationProfileRow {
  id: string
  builder_id: string
  typical_margin_pct: number | null
  typical_contingency_pct: number | null
  typical_labour_loading: number | null
  finish_level: string | null
  avg_adjustment_pct: number | null
  adjustment_direction: 'increase' | 'decrease' | 'neutral' | null
  avg_variations_per_job: number | null
  avg_variation_value: number | null
  quotes_generated: number
  jobs_completed: number
  avg_quote_accuracy_pct: number | null
  preferred_suppliers: string[] | null
  updated_at: string
}

export interface ScopeIntelligencePattern {
  id: string
  renovation_type: string | null
  trigger_keywords: string[]
  likely_items: Array<{
    description: string
    trade_category_id: number
    confidence: number
    typical_cost_range?: string
    reason: string
  }>
  created_at: string
}

// ─── API rate limiting (migration 021) ───────────────────────────────────────

export interface ApiRateLimit {
  key: string
  window_start: string
  count: number
}

// ─── Supabase Database type (for typed client) ───────────────────────────────

export interface Database {
  public: {
    Tables: {
      builders: {
        Row: Builder
        Insert: Omit<Builder, 'id' | 'created_at'> & Partial<Pick<Builder, 'id' | 'created_at'>>
        Update: Partial<Omit<Builder, 'id'>>
      }
      workers: {
        Row: Worker
        Insert: Omit<Worker, 'id' | 'created_at' | 'invite_token'> & Partial<Pick<Worker, 'id' | 'created_at' | 'invite_token'>>
        Update: Partial<Omit<Worker, 'id'>>
      }
      clients: {
        Row: Client
        Insert: Omit<Client, 'id' | 'created_at'> & Partial<Pick<Client, 'id' | 'created_at'>>
        Update: Partial<Omit<Client, 'id'>>
      }
      trade_categories: {
        Row: TradeCategory
        Insert: Omit<TradeCategory, 'id'> & Partial<Pick<TradeCategory, 'id'>>
        Update: Partial<Omit<TradeCategory, 'id'>>
      }
      jobs: {
        Row: Job
        Insert: Omit<Job, 'id' | 'created_at' | 'updated_at'> & Partial<Pick<Job, 'id' | 'created_at' | 'updated_at'>>
        Update: Partial<Omit<Job, 'id'>>
      }
      quotes: {
        Row: Quote
        Insert: Omit<Quote, 'id' | 'created_at'> & Partial<Pick<Quote, 'id' | 'created_at'>>
        Update: Partial<Omit<Quote, 'id'>>
      }
      quote_line_items: {
        Row: QuoteLineItem
        Insert: Omit<QuoteLineItem, 'id' | 'created_at'> & Partial<Pick<QuoteLineItem, 'id' | 'created_at'>>
        Update: Partial<Omit<QuoteLineItem, 'id'>>
      }
      cost_rates: {
        Row: CostRate
        Insert: Omit<CostRate, 'id' | 'created_at'> & Partial<Pick<CostRate, 'id' | 'created_at'>>
        Update: Partial<Omit<CostRate, 'id'>>
      }
      builder_learned_rates: {
        Row: BuilderLearnedRate
        Insert: Omit<BuilderLearnedRate, 'id' | 'updated_at'> & Partial<Pick<BuilderLearnedRate, 'id' | 'updated_at'>>
        Update: Partial<Omit<BuilderLearnedRate, 'id'>>
      }
      builder_rate_preferences: {
        Row: BuilderRatePreference
        Insert: Omit<BuilderRatePreference, 'id' | 'set_at'> & Partial<Pick<BuilderRatePreference, 'id' | 'set_at'>>
        Update: Partial<Omit<BuilderRatePreference, 'id'>>
      }
      builder_supplier_rates: {
        Row: BuilderSupplierRate
        Insert: Omit<BuilderSupplierRate, 'id' | 'imported_at'> & Partial<Pick<BuilderSupplierRate, 'id' | 'imported_at'>>
        Update: Partial<Omit<BuilderSupplierRate, 'id'>>
      }
      network_rate_aggregates: {
        Row: NetworkRateAggregate
        Insert: Omit<NetworkRateAggregate, 'id' | 'updated_at'> & Partial<Pick<NetworkRateAggregate, 'id' | 'updated_at'>>
        Update: Partial<Omit<NetworkRateAggregate, 'id'>>
      }
      variations: {
        Row: Variation
        Insert: Omit<Variation, 'id' | 'created_at'> & Partial<Pick<Variation, 'id' | 'created_at'>>
        Update: Partial<Omit<Variation, 'id'>>
      }
      invoices: {
        Row: Invoice
        Insert: Omit<Invoice, 'id' | 'created_at'> & Partial<Pick<Invoice, 'id' | 'created_at'>>
        Update: Partial<Omit<Invoice, 'id'>>
      }
      communication_history: {
        Row: CommunicationHistory
        Insert: Omit<CommunicationHistory, 'id' | 'timestamp'> & Partial<Pick<CommunicationHistory, 'id' | 'timestamp'>>
        Update: Partial<Omit<CommunicationHistory, 'id'>>
      }
      files: {
        Row: File
        Insert: Omit<File, 'id' | 'created_at'> & Partial<Pick<File, 'id' | 'created_at'>>
        Update: Partial<Omit<File, 'id'>>
      }
      assumptions: {
        Row: Assumption
        Insert: Omit<Assumption, 'id' | 'created_at'> & Partial<Pick<Assumption, 'id' | 'created_at'>>
        Update: Partial<Omit<Assumption, 'id'>>
      }
      job_workers: {
        Row: JobWorker
        Insert: Omit<JobWorker, 'id' | 'assigned_at'> & Partial<Pick<JobWorker, 'id' | 'assigned_at'>>
        Update: Partial<Omit<JobWorker, 'id'>>
      }
      job_milestones: {
        Row: JobMilestone
        Insert: Omit<JobMilestone, 'id' | 'created_at'> & Partial<Pick<JobMilestone, 'id' | 'created_at'>>
        Update: Partial<Omit<JobMilestone, 'id'>>
      }
      invoice_schedule: {
        Row: InvoiceScheduleEntry
        Insert: Omit<InvoiceScheduleEntry, 'id' | 'created_at'> & Partial<Pick<InvoiceScheduleEntry, 'id' | 'created_at'>>
        Update: Partial<Omit<InvoiceScheduleEntry, 'id'>>
      }
      proof_events: {
        Row: ProofEventRow
        Insert: Omit<ProofEventRow, 'id' | 'created_at'> & Partial<Pick<ProofEventRow, 'id' | 'created_at'>>
        Update: Partial<Omit<ProofEventRow, 'id'>>
      }
      trade_subcategories: {
        Row: TradeSubcategory
        Insert: Omit<TradeSubcategory, 'id'> & Partial<Pick<TradeSubcategory, 'id'>>
        Update: Partial<Omit<TradeSubcategory, 'id'>>
      }
      project_memory: {
        Row: ProjectMemoryRow
        Insert: Omit<ProjectMemoryRow, 'id' | 'created_at'> & Partial<Pick<ProjectMemoryRow, 'id' | 'created_at'>>
        Update: Partial<Omit<ProjectMemoryRow, 'id'>>
      }
      cost_reconciliation: {
        Row: CostReconciliation
        Insert: Omit<CostReconciliation, 'id' | 'created_at' | 'variance_amount'> & Partial<Pick<CostReconciliation, 'id' | 'created_at'>>
        Update: Partial<Omit<CostReconciliation, 'id' | 'variance_amount'>>
      }
      builder_estimation_profiles: {
        Row: BuilderEstimationProfileRow
        Insert: Omit<BuilderEstimationProfileRow, 'id' | 'updated_at'> & Partial<Pick<BuilderEstimationProfileRow, 'id' | 'updated_at'>>
        Update: Partial<Omit<BuilderEstimationProfileRow, 'id'>>
      }
      scope_intelligence_patterns: {
        Row: ScopeIntelligencePattern
        Insert: Omit<ScopeIntelligencePattern, 'id' | 'created_at'> & Partial<Pick<ScopeIntelligencePattern, 'id' | 'created_at'>>
        Update: Partial<Omit<ScopeIntelligencePattern, 'id'>>
      }
      api_rate_limits: {
        Row: ApiRateLimit
        Insert: ApiRateLimit
        Update: Partial<ApiRateLimit>
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: {
      australian_state: AustralianState
      builder_plan: BuilderPlan
      worker_status: WorkerStatus
      job_status: JobStatus
      quote_status: QuoteStatus
      assumption_status: AssumptionStatus
      variation_status: VariationStatus
      invoice_status: InvoiceStatus
      communication_direction: CommunicationDirection
      communication_channel: CommunicationChannel
      file_type: FileType
      file_intake_status: FileIntakeStatus
      resolution_type: ResolutionType
    }
    CompositeTypes: Record<string, never>
  }
}

// ─── API / Edge Function payload types ───────────────────────────────────────

export type IntentType =
  | 'morning_brief'
  | 'add_worker'
  | 'new_job'
  | 'job_query'
  | 'variation'
  | 'invoice'
  | 'unknown'

// ─── Multi-action extraction types ───────────────────────────────────────────

export type ActionType =
  | 'morning_brief'
  | 'add_worker'
  | 'create_job'
  | 'job_query'
  | 'variation'
  | 'invoice'
  | 'email_draft'
  | 'email_sync_status'
  | 'simulate_email'
  | 'margin_query'
  | 'open_upload_panel'
  | 'review_assumptions'
  | 'update_job_context'
  | 'add_task'
  | 'upload_rates'
  | 'client_lookup'
  | 'meeting_prep'
  | 'payment_risk'
  | 'conflict_detected'
  | 'worker_onboarding'
  | 'roadmap'
  | 'team_notifications'
  | 'approve_quote'
  | 'end_of_day'
  | 'task_help'
  | 'unknown'

export interface ExtractedAction {
  type: ActionType
  entities: Record<string, string>
  confidence: number
}

export interface ExtractActionsResponse {
  actions: ExtractedAction[]
  raw_context: Record<string, string>
}

export interface ClassifyIntentRequest {
  message: string
  builder_id: string
}

export interface ClassifyIntentResponse {
  intent: IntentType
  entities: Record<string, string>
  confidence: number
  raw_message: string
}

export interface MorningBriefRequest {
  builder_id: string
}

export interface MorningBriefAlert {
  priority: 'high' | 'medium' | 'low'
  message: string
  action?: string
  entity_id?: string
  entity_type?: string
}

export interface MorningBriefResponse {
  brief: string
  alerts: MorningBriefAlert[]
}

export interface CreateWorkerRequest {
  builder_id: string
  name: string
  role: string
  email?: string
  phone?: string
}

export interface WorkerModalEvent {
  type: 'open_worker_modal'
  worker_id: string
}

export interface CreateWorkerResponse {
  worker: Worker
  invite_url: string
  modal_event: WorkerModalEvent
}

export interface CreateJobRequest {
  builder_id: string
  address: string
  client_name?: string
}

export type UIEventType = 'open_upload_panel' | 'show_duplicate_warning'

export interface UIEvent {
  type: UIEventType
  job_id: string
}

export interface CreateJobResponse {
  job: Job
  event: UIEvent
  duplicate?: false
}

export interface CreateJobDuplicateResponse {
  duplicate: true
  existing_job: Job
  event: UIEvent
}

export type CreateJobResult = CreateJobResponse | CreateJobDuplicateResponse
