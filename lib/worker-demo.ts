// Demo worker and job data for /join and /worker flows.

export interface DemoWorkerInvite {
  token: string
  worker_id: string
  worker_name: string
  role: string
  builder_name: string
  builder_company: string
  builder_phone: string
  job_address: string
  job_ref: string
}

export interface DemoWorkerJob {
  id: string
  ref: string
  address: string
  suburb: string
  status: string
  start_time: string
  milestone_label: string
  milestone_week: string
  milestone_due_display: string
  milestone_due_urgency: 'ok' | 'soon' | 'overdue'
  builder_name: string
  builder_phone: string
  site_supervisor: string
  tasks: Array<{ label: string; done: boolean }>
}

export interface DemoWorker {
  id: string
  name: string
  role: string
  initials: string
  builder_name: string
  builder_company: string
  jobs: DemoWorkerJob[]
}

// ─── Demo invite tokens ───────────────────────────────────────────────────────

const DEMO_INVITES: DemoWorkerInvite[] = [
  {
    token: 'demo-invite-token',
    worker_id: 'w-jack-001',
    worker_name: 'Jack Thompson',
    role: 'Carpenter',
    builder_name: 'Dave Nguyen',
    builder_company: 'Nguyen Constructions',
    builder_phone: '+61 400 123 456',
    job_address: '14 Merri St, Fitzroy VIC 3065',
    job_ref: 'JOB-2025-001',
  },
  {
    token: 'demo-invite-mick',
    worker_id: 'w-mick-002',
    worker_name: 'Mick Reynolds',
    role: 'Plumber',
    builder_name: 'Dave Nguyen',
    builder_company: 'Nguyen Constructions',
    builder_phone: '+61 400 123 456',
    job_address: '14 Merri St, Fitzroy VIC 3065',
    job_ref: 'JOB-2025-001',
  },
]

export function getDemoInvite(token: string): DemoWorkerInvite | null {
  return DEMO_INVITES.find((i) => i.token === token) ?? DEMO_INVITES[0]
}

// ─── Demo worker portal data ──────────────────────────────────────────────────

export const DEMO_WORKER_JACK: DemoWorker = {
  id: 'w-jack-001',
  name: 'Jack Thompson',
  role: 'Carpenter',
  initials: 'JT',
  builder_name: 'Dave Nguyen',
  builder_company: 'Nguyen Constructions',
  jobs: [
    {
      id: '00000000-0000-0000-0000-000000000010',
      ref: 'JOB-2025-001',
      address: '14 Merri St',
      suburb: 'Fitzroy VIC 3065',
      status: 'active',
      start_time: '7:00 AM',
      milestone_label: 'Framing Complete',
      milestone_week: 'Week 4 of 17',
      milestone_due_display: 'Due in 3 days',
      milestone_due_urgency: 'soon',
      builder_name: 'Dave Nguyen',
      builder_phone: '+61 400 123 456',
      site_supervisor: 'Dave Nguyen',
      tasks: [
        { label: 'Wall framing — ground floor', done: true },
        { label: 'Wall framing — first floor', done: true },
        { label: 'Roof framing', done: false },
        { label: 'LVL beam installation', done: false },
        { label: 'Frame inspection sign-off', done: false },
      ],
    },
  ],
}
