// ─── Job snapshot demo data ───────────────────────────────────────────────────
// Full demo snapshots for all three seed jobs.
// All dates are plain English. All amounts are formatted strings or raw numbers
// (the UI layer does the currency formatting).

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProofEvent {
  id: string
  type: string
  description: string
  actor: string
  entity_ref?: string
  timestamp: string
}

export interface JobRisk {
  level: 'high' | 'medium' | 'low'
  message: string
}

export interface JobHealth {
  label: 'On Track' | 'Watch' | 'At Risk'
  // Disclosed rule, not a predictive score: derived from the same `risks`
  // array below (highest risk severity present). Never a fabricated
  // confidence percentage.
  reasons: string[]
}

export interface JobTask {
  id: string
  description: string
  assigned_to: string | null
  assigned_worker_id: string | null
  status: 'open' | 'done'
  created_at: string
}

export interface JobWorkerRef {
  id: string
  name: string
  role: string
}

export interface JobSnapshot {
  job: {
    id: string
    address: string
    status: string
    job_type: string | null
    client_name: string | null
    client_email: string | null
    client_phone: string | null
    created_at: string
    days_active: number
    job_ref?: string
    budget_estimate: number | null
    scope_notes: string | null
    quote_deadline: string | null  // ISO date or null
    client_deadline: string | null // ISO date or null
  }
  overview: {
    started: string
    workers_on_job: string[]
    last_activity: string
    notes: string | null
    /** Canonical client-facing price (calculateClientPrice) — null when there's no quote yet. */
    contract_value: number | null
    /** SUM of job_cost_entries.amount — the costs the builder has actually logged. 0, never null, when nothing's been logged. */
    actual_cost: number
    /** contract_value - actual_cost. Null only when contract_value is null (no quote). */
    current_margin: number | null
    /** current_margin / contract_value * 100, rounded. Null when contract_value is null or 0. */
    current_margin_pct: number | null
  }
  quote: {
    id: string | null
    status: string | null
    total_cost: number | null
    confidence_score: number | null
    sent_at: string | null
    version: number
    unresolved_count: number
    quote_ref?: string
  } | null
  variations: Array<{
    id: string
    title: string
    amount: number
    status: string
    created_at: string
    variation_ref?: string
    labour_cost?: number
    materials_cost?: number
    submitted_by?: string
  }>
  invoices: Array<{
    id: string
    amount: number
    status: string
    due_date: string
    sent_at: string | null
  }>
  files: Array<{
    id: string
    filename: string
    file_type: string
    intake_status: string
    uploaded_at: string
  }>
  comms: {
    messages: Array<{
      id: string
      direction: 'inbound' | 'outbound'
      channel: string
      subject: string | null
      preview: string
      timestamp: string
    }>
    proof_events?: ProofEvent[]
  }
  workers: JobWorkerRef[]
  tasks: JobTask[]
  risks: JobRisk[]
  job_health: JobHealth
  // Count of job_milestones rows — real signal for the "Work Scheduled"
  // timeline step (milestones are generated on job activation).
  milestones_count: number
  // Open blocking clarifying_questions (Stage 4/5) — the estimating engine
  // paused here and won't resume until these are answered. Previously only
  // ever surfaced inside the live upload SSE session (IntakeProgress); a
  // builder who closed that panel or reloaded the page had no way back to
  // it. clarify_file_id is whatever files.id the /clarify route needs in its
  // URL — it re-derives the real paused file itself, so any file belonging
  // to the job works.
  pending_clarifying_questions: Array<{ id: string; question: string; reason: string }>
  // Non-blocking open questions — informational, never pause estimating.
  // Previously never surfaced in any builder UI; see JobSnapshotPanel's
  // "Worth knowing" section.
  pending_non_blocking_questions: Array<{ id: string; question: string; reason: string }>
  clarify_file_id: string | null
}

export interface TimelineStep {
  label: string
  done: boolean
  current: boolean
}

// Vertical checklist for the sidebar — six sub-steps, each backed by a real
// column (see the field it reads). Drops the brief's "Measurements
// Complete" step (no real signal backs it as a distinct milestone) and
// relabels "Deposit Paid" to "Deposit Invoiced" — the invoice_schedule
// data available here tracks whether an invoice was raised, not whether it
// was actually paid.
export function deriveTimelineSteps(snapshot: JobSnapshot): TimelineStep[] {
  const done = [
    snapshot.files.length > 0,
    snapshot.quote != null,
    snapshot.quote?.sent_at != null,
    snapshot.quote?.status === 'approved' || snapshot.job.status === 'active' || snapshot.job.status === 'complete',
    snapshot.invoices.some(i => i.status === 'sent' || i.status === 'paid'),
    snapshot.milestones_count > 0,
  ]
  const labels = ['Plans Uploaded', 'Quote Drafted', 'Quote Sent', 'Client Approved', 'Deposit Invoiced', 'Work Scheduled']
  const currentIdx = done.findIndex(d => !d)
  return labels.map((label, i) => ({ label, done: done[i], current: i === currentIdx }))
}

// Disclosed rule, not a predictive score: highest risk severity present
// determines the label. Never a fabricated confidence percentage.
export function deriveJobHealth(risks: JobRisk[]): JobHealth {
  const highs = risks.filter(r => r.level === 'high')
  if (highs.length > 0) return { label: 'At Risk', reasons: highs.map(r => r.message) }
  const meds = risks.filter(r => r.level === 'medium')
  if (meds.length > 0) return { label: 'Watch', reasons: meds.map(r => r.message) }
  return {
    label: 'On Track',
    reasons: risks.length > 0 ? risks.map(r => r.message) : ['No open risks — quote, invoices, and files are all up to date.'],
  }
}

// ─── Job 1: Fitzroy (active) ──────────────────────────────────────────────────

const JOB_1_FITZROY: Omit<JobSnapshot, 'job_health'> = {
  job: {
    id: '00000000-0000-0000-0000-000000000010',
    address: '14 Merri St, Fitzroy VIC 3065',
    status: 'active',
    job_type: 'renovation',
    client_name: 'Hendersons',
    client_email: 'henderson@example.com',
    client_phone: '0412 000 001',
    created_at: '45 days ago',
    days_active: 45,
    job_ref: 'JOB-2025-001',
    budget_estimate: null,
    scope_notes: 'Full kitchen and bathroom renovation',
    quote_deadline: null,
    client_deadline: null,
  },
  overview: {
    started: '45 days ago',
    workers_on_job: ['Jack (Carpenter)', 'Mick (Plumber)'],
    last_activity: '2 days ago',
    notes: null,
    contract_value: 163300,
    actual_cost: 112000,
    current_margin: 51300,
    current_margin_pct: 31,
  },
  quote: {
    id: 'demo-fitzroy-quote',
    status: 'approved',
    total_cost: 142000,
    confidence_score: 95,
    sent_at: '45 days ago',
    version: 1,
    unresolved_count: 0,
  },
  variations: [
    {
      id: 'demo-var-001',
      title: 'Upgrade kitchen benchtop to 40mm Caesarstone',
      amount: 3200,
      status: 'pending',
      created_at: '2 days ago',
      variation_ref: 'VAR-001',
      labour_cost: 800,
      materials_cost: 2400,
      submitted_by: 'Tom Chen',
    },
    {
      id: 'demo-var-002',
      title: 'Add extra GPO points to living room',
      amount: 680,
      status: 'pending',
      created_at: '4 days ago',
      variation_ref: 'VAR-002',
      labour_cost: 680,
      materials_cost: 0,
      submitted_by: 'Tom Chen',
    },
  ],
  invoices: [
    {
      id: 'demo-inv-001',
      amount: 28000,
      status: 'overdue',
      due_date: '3 days ago',
      sent_at: '7 days ago',
    },
  ],
  workers: [
    { id: 'w-jack-001', name: 'Jack Thompson', role: 'Carpenter' },
    { id: 'w-mick-002', name: 'Mick Reynolds', role: 'Plumber' },
  ],
  tasks: [
    {
      id: 'demo-task-001',
      description: 'Install kitchen cabinetry frames before Wednesday',
      assigned_to: 'Jack Thompson',
      assigned_worker_id: 'w-jack-001',
      status: 'open',
      created_at: 'yesterday',
    },
    {
      id: 'demo-task-002',
      description: 'Rough-in hot water connections to bathroom',
      assigned_to: 'Mick Reynolds',
      assigned_worker_id: 'w-mick-002',
      status: 'open',
      created_at: '2 days ago',
    },
    {
      id: 'demo-task-003',
      description: 'Site clean before client inspection',
      assigned_to: null,
      assigned_worker_id: null,
      status: 'done',
      created_at: '5 days ago',
    },
  ],
  files: [],
  comms: {
    messages: [
      {
        id: 'demo-comm-001',
        direction: 'outbound',
        channel: 'email',
        subject: 'Invoice — 14 Merri St, Fitzroy',
        preview: 'Hi, please find your invoice attached for the work completed at 14 Merri St, Fitz',
        timestamp: '7 days ago',
      },
      {
        id: 'demo-comm-002',
        direction: 'outbound',
        channel: 'email',
        subject: 'Variation request — kitchen benchtop upgrade',
        preview: 'Hi, we have a variation request for your approval: upgrade kitchen benchtop to 40m',
        timestamp: '2 days ago',
      },
      {
        id: 'demo-comm-003',
        direction: 'outbound',
        channel: 'email',
        subject: 'Variation request — additional GPO points',
        preview: 'Hi, we have a variation request for your approval: add extra GPO points to the liv',
        timestamp: '4 days ago',
      },
    ],
    proof_events: [],
  },
  milestones_count: 8,
  pending_clarifying_questions: [],
  pending_non_blocking_questions: [],
  clarify_file_id: null,
  risks: [
    { level: 'high', message: '2 variations pending approval.' },
    { level: 'high', message: 'Invoice for $28,000 overdue 3 days.' },
  ],
}

// ─── Job 2: Toorak (quoted) ───────────────────────────────────────────────────

const JOB_2_TOORAK: Omit<JobSnapshot, 'job_health'> = {
  job: {
    id: '00000000-0000-0000-0000-000000000011',
    address: '8 Burnside Rd, Toorak VIC 3142',
    status: 'quoted',
    job_type: null,
    client_name: 'Tom Caruso',
    client_email: 'tom.caruso@example.com',
    client_phone: '0412 000 002',
    created_at: '12 days ago',
    days_active: 12,
    job_ref: 'JOB-2025-002',
    budget_estimate: 127500,
    scope_notes: null,
    quote_deadline: null,
    client_deadline: null,
  },
  overview: {
    started: '12 days ago',
    workers_on_job: [],
    last_activity: '5 days ago',
    notes: null,
    contract_value: 146625,
    actual_cost: 0,
    current_margin: 146625,
    current_margin_pct: 100,
  },
  quote: {
    id: 'demo-quote-id-toorak',
    status: 'sent',
    total_cost: 127500,
    confidence_score: 82,
    sent_at: '5 days ago',
    version: 1,
    unresolved_count: 0,
    quote_ref: 'QT-JOB-2025-002-v1',
  },
  workers: [],
  tasks: [],
  variations: [],
  invoices: [],
  files: [],
  comms: {
    messages: [
      {
        id: 'demo-comm-toorak-001',
        direction: 'outbound',
        channel: 'email',
        subject: 'Quote — 8 Burnside Rd, Toorak',
        preview: 'Hi Tom, please find your quote attached for the work at 8 Burnside Rd. Total: $127',
        timestamp: '5 days ago',
      },
    ],
    proof_events: [
      {
        id: 'pe-1',
        type: 'job_activated',
        description: 'Job activated',
        actor: 'Dave Nguyen',
        timestamp: '2025-04-01T09:00:00Z',
      },
      {
        id: 'pe-2',
        type: 'variation_submitted',
        description: 'VAR-001 submitted — Benchtop upgrade ($3,200)',
        actor: 'Tom Chen',
        entity_ref: 'VAR-001',
        timestamp: '2025-05-10T14:30:00Z',
      },
      {
        id: 'pe-3',
        type: 'email_draft_created',
        description: 'Email draft created for VAR-001 notification',
        actor: 'Dave Nguyen',
        entity_ref: 'VAR-001',
        timestamp: '2025-05-10T14:35:00Z',
      },
      {
        id: 'pe-4',
        type: 'email_sent',
        description: 'Variation notification email sent to Sarah Mitchell',
        actor: 'Dave Nguyen',
        entity_ref: 'VAR-001',
        timestamp: '2025-05-10T15:02:00Z',
      },
    ],
  },
  milestones_count: 0,
  pending_clarifying_questions: [],
  pending_non_blocking_questions: [],
  clarify_file_id: null,
  risks: [
    { level: 'medium', message: 'Quote sent 5 days ago with no response from Tom Caruso.' },
    { level: 'low', message: 'Client email on file — ready to follow up.' },
  ],
}

// ─── Job 3: Brunswick (quoting) ───────────────────────────────────────────────

const JOB_3_BRUNSWICK: Omit<JobSnapshot, 'job_health'> = {
  job: {
    id: '00000000-0000-0000-0000-000000000012',
    address: '52 Bendigo St, Brunswick VIC 3056',
    status: 'quoting',
    job_type: null,
    client_name: null,
    client_email: null,
    client_phone: null,
    created_at: '3 days ago',
    days_active: 3,
    job_ref: 'JOB-2025-003',
    budget_estimate: 380000,
    scope_notes: 'Rear extension',
    quote_deadline: null,
    client_deadline: null,
  },
  overview: {
    started: '3 days ago',
    workers_on_job: [],
    last_activity: 'today',
    notes: null,
    contract_value: 146625,
    actual_cost: 0,
    current_margin: 146625,
    current_margin_pct: 100,
  },
  quote: {
    id: 'demo-quote-id',
    status: 'pending_review',
    total_cost: 127500,
    confidence_score: 45,
    sent_at: null,
    version: 1,
    unresolved_count: 2,
    quote_ref: 'QT-JOB-2025-003-v1',
  },
  workers: [],
  tasks: [],
  variations: [],
  invoices: [],
  files: [],
  comms: {
    messages: [],
    proof_events: [],
  },
  milestones_count: 0,
  pending_clarifying_questions: [],
  pending_non_blocking_questions: [],
  clarify_file_id: null,
  risks: [
    { level: 'medium', message: 'Budget noted ($380,000) but no plans uploaded yet.' },
    { level: 'medium', message: '2 assumptions need resolving before quote can be sent.' },
    { level: 'low', message: 'Client email missing — required to send quote.' },
  ],
}

// ─── Lookup map ───────────────────────────────────────────────────────────────

const DEMO_SNAPSHOTS: Record<string, Omit<JobSnapshot, 'job_health'>> = {
  '00000000-0000-0000-0000-000000000010': JOB_1_FITZROY,
  // Toorak — both IDs resolve (chat uses 020, snapshot panel uses 011)
  '00000000-0000-0000-0000-000000000011': JOB_2_TOORAK,
  '00000000-0000-0000-0000-000000000020': JOB_2_TOORAK,
  '00000000-0000-0000-0000-000000000012': JOB_3_BRUNSWICK,
  // Brunswick — alias used in chat route
  '00000000-0000-0000-0000-000000000030': JOB_3_BRUNSWICK,
}

// ─── Export ───────────────────────────────────────────────────────────────────

export function getDemoJobSnapshot(jobId: string): JobSnapshot | null {
  const snapshot = DEMO_SNAPSHOTS[jobId]
  if (!snapshot) return null
  return { ...snapshot, job_health: deriveJobHealth(snapshot.risks) }
}

export function getDemoJobList(): Array<{ id: string; address: string; status: string }> {
  return [
    { id: '00000000-0000-0000-0000-000000000010', address: '14 Merri St, Fitzroy VIC 3065', status: 'active' },
    { id: '00000000-0000-0000-0000-000000000011', address: '8 Burnside Rd, Toorak VIC 3142', status: 'quoted' },
    { id: '00000000-0000-0000-0000-000000000012', address: '52 Bendigo St, Brunswick VIC 3056', status: 'quoting' },
  ]
}
