// ─── Job snapshot demo data ───────────────────────────────────────────────────
// Full demo snapshots for all three seed jobs.
// All dates are plain English. All amounts are formatted strings or raw numbers
// (the UI layer does the currency formatting).

// ─── Types ────────────────────────────────────────────────────────────────────

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
  }
  overview: {
    started: string
    workers_on_job: string[]
    last_activity: string
    notes: string | null
    margin_to_date: number | null
    spend_to_date: number | null
  }
  quote: {
    id: string | null
    status: string | null
    total_cost: number | null
    confidence_score: number | null
    sent_at: string | null
    version: number
    unresolved_count: number
  } | null
  variations: Array<{
    id: string
    title: string
    amount: number
    status: string
    created_at: string
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
  comms: Array<{
    id: string
    direction: 'inbound' | 'outbound'
    channel: string
    subject: string | null
    preview: string
    timestamp: string
  }>
}

// ─── Job 1: Fitzroy (active) ──────────────────────────────────────────────────

const JOB_1_FITZROY: JobSnapshot = {
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
  },
  overview: {
    started: '45 days ago',
    workers_on_job: ['Jack (Carpenter)', 'Mick (Plumber)'],
    last_activity: '2 days ago',
    notes: null,
    margin_to_date: null,
    spend_to_date: null,
  },
  quote: null,
  variations: [
    {
      id: 'demo-var-001',
      title: 'Upgrade kitchen benchtop to 40mm Caesarstone',
      amount: 3200,
      status: 'pending',
      created_at: '2 days ago',
    },
    {
      id: 'demo-var-002',
      title: 'Add extra GPO points to living room',
      amount: 680,
      status: 'pending',
      created_at: '4 days ago',
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
  files: [],
  comms: [
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
}

// ─── Job 2: Toorak (quoted) ───────────────────────────────────────────────────

const JOB_2_TOORAK: JobSnapshot = {
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
  },
  overview: {
    started: '12 days ago',
    workers_on_job: [],
    last_activity: '5 days ago',
    notes: null,
    margin_to_date: null,
    spend_to_date: null,
  },
  quote: {
    id: 'demo-quote-id-toorak',
    status: 'sent',
    total_cost: 127500,
    confidence_score: 82,
    sent_at: '5 days ago',
    version: 1,
    unresolved_count: 0,
  },
  variations: [],
  invoices: [],
  files: [],
  comms: [
    {
      id: 'demo-comm-toorak-001',
      direction: 'outbound',
      channel: 'email',
      subject: 'Quote — 8 Burnside Rd, Toorak',
      preview: 'Hi Tom, please find your quote attached for the work at 8 Burnside Rd. Total: $127',
      timestamp: '5 days ago',
    },
  ],
}

// ─── Job 3: Brunswick (quoting) ───────────────────────────────────────────────

const JOB_3_BRUNSWICK: JobSnapshot = {
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
  },
  overview: {
    started: '3 days ago',
    workers_on_job: [],
    last_activity: 'today',
    notes: null,
    margin_to_date: null,
    spend_to_date: null,
  },
  quote: {
    id: 'demo-quote-id',
    status: 'pending_review',
    total_cost: 127500,
    confidence_score: 45,
    sent_at: null,
    version: 1,
    unresolved_count: 2,
  },
  variations: [],
  invoices: [],
  files: [],
  comms: [],
}

// ─── Lookup map ───────────────────────────────────────────────────────────────

const DEMO_SNAPSHOTS: Record<string, JobSnapshot> = {
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
  return DEMO_SNAPSHOTS[jobId] ?? null
}
