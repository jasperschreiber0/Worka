import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import type {
  IntentType,
  Invoice,
  Variation,
  Quote,
  Job,
  Worker,
} from '@/lib/types/database.types'
import { DEMO_VARIATIONS, demoVariationState, type DemoVariation } from '@/lib/variations-demo'

// ─── Extended intent type (includes email_draft, email_sync_status, simulate_email) ──

type ExtendedIntentType = IntentType | 'email_draft' | 'email_sync_status' | 'simulate_email' | 'margin_query'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatRequestBody {
  message: string
  builder_id?: string
  force_create?: boolean
}

interface Alert {
  priority: 'high' | 'medium' | 'low'
  message: string
  action?: string
  entity_id?: string
  entity_type?: 'job' | 'invoice' | 'variation' | 'quote'
}

interface WorkerModalEvent {
  type: 'open_worker_modal'
  worker_id: string
}

interface UploadPanelEvent {
  type: 'open_upload_panel'
  job_id: string
}

interface DuplicateWarningEvent {
  type: 'show_duplicate_warning'
  job_id: string
}

interface OpenJobSnapshotEvent {
  type: 'open_job_snapshot'
  job_id: string
  job_address: string
  job_status: string
  client_name?: string
  job_ref?: string
}

interface ShowVariationEvent {
  type: 'show_variation'
  variation_id: string
  job_id: string
}

interface OpenEmailDraftEvent {
  type: 'open_email_draft'
  job_id: string | null
  recipient_name: string | null
  intent_hint: string
}

interface SuggestEmailDraftEvent {
  type: 'suggest_email_draft'
  job_id: string
  intent_hint: string
}

interface InboundEmailAlertEvent {
  type: 'inbound_email_alert'
  email: {
    from: string
    subject: string
    preview: string
    received_display: string
  }
  job_address: string
  intent: string
  suggested_action: {
    type: string
    description: string
    draft?: { subject: string; body: string }
  } | null
}

interface SuggestJobActivationEvent {
  type: 'suggest_job_activation'
  job_id: string
  quote_id: string
}

type ChatEvent = WorkerModalEvent | UploadPanelEvent | DuplicateWarningEvent | OpenJobSnapshotEvent | ShowVariationEvent | OpenEmailDraftEvent | SuggestEmailDraftEvent | InboundEmailAlertEvent | SuggestJobActivationEvent

export interface MarginJob {
  id: string
  job_ref: string
  address: string
  status: string
  quoted_amount: number
  projected_cost: number
  margin_amount: number
  margin_percent: number
  quoted_margin_percent: number
  cost_to_date: number
  variation_impact: number
}

interface ChatResponse {
  intent: string
  message: string
  alerts?: Alert[]
  worker?: Worker
  invite_url?: string
  job?: Job
  duplicate?: boolean
  existing_job?: Job
  variation?: DemoVariation
  all_variations?: DemoVariation[]
  margin_jobs?: MarginJob[]
  event?: ChatEvent
}

interface ClassifyResult {
  intent: ExtendedIntentType
  entities: Record<string, string>
  confidence: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a plain-English relative date string.
 * Never returns ISO strings or raw timestamps.
 */
function relativeDate(dateInput: string | Date): string {
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  if (diffDays < 14) return 'last week'
  if (diffDays < 21) return '2 weeks ago'
  if (diffDays < 28) return '3 weeks ago'
  const diffWeeks = Math.floor(diffDays / 7)
  if (diffWeeks < 8) return `${diffWeeks} weeks ago`
  const diffMonths = Math.floor(diffDays / 30)
  return `${diffMonths} month${diffMonths !== 1 ? 's' : ''} ago`
}

function formatAUD(amount: number): string {
  return `$${amount.toLocaleString('en-AU')}`
}

// ─── Intent Classification ────────────────────────────────────────────────────

async function classifyIntent(
  message: string,
  anthropic: Anthropic
): Promise<ClassifyResult> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 256,
    system: `You are an intent classifier for WorkA, an AI operations manager for Australian residential builders.

Classify the builder's message into exactly one of these intents:
- morning_brief: asking what's on today, what needs attention, daily summary, status check
- add_worker: adding, inviting, or registering a new crew member or worker
- new_job: starting a new job, new quote, new project at a NEW address not yet in the system. NOT vague quoting requests like "I need to quote" or "do a quote"
- job_query: asking about an existing job, listing jobs, project status, or client. Also vague quoting requests like "I need to quote", "list my jobs", "show all jobs", "what jobs do I have"
- variation: variation requests, change orders, scope changes
- invoice: invoices, payments, billing queries
- email_draft: builder wants to draft/send an email to a client or subcontractor
  Examples: "email the Hendersons", "draft an email to Tom about the quote", "send a message to the client", "follow up on the Toorak quote"
- email_sync_status: builder asking if email sync is connected, or for email sync status
  Examples: "is my email connected?", "email sync status", "is Gmail connected", "check email sync"
- simulate_email: builder wants to test email sync or simulate an inbound email
  Examples: "simulate email", "test email sync", "simulate inbound email", "demo email"
- margin_query: asking about job margin, profit, costs, which job is losing money, cost overruns
  Examples: "which job is bleeding margin", "how's my margin", "what's the profit on Fitzroy", "any jobs losing money", "cost overrun"
- unknown: anything that doesn't fit the above

Extract relevant entities:
- For add_worker: name, role
- For new_job: address, client_name (if mentioned)
- For job_query: address or job name
- For variation/invoice: job reference if mentioned
- For email_draft: recipient_name (who to email), job_reference (which job), intent_hint (what it's about: invoice/quote_followup/variation/general)

Respond with ONLY valid JSON in this exact format:
{
  "intent": "<intent_value>",
  "entities": { "<key>": "<value>" },
  "confidence": <number 0-100>
}`,
    messages: [{ role: 'user', content: message }],
  })

  const content = response.content[0]
  if (content.type !== 'text') {
    return { intent: 'unknown', entities: {}, confidence: 0 }
  }

  try {
    // Strip markdown code fences if present
    const cleaned = content.text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    const parsed = JSON.parse(cleaned) as ClassifyResult
    return parsed
  } catch {
    return { intent: 'unknown', entities: {}, confidence: 0 }
  }
}

// ─── Demo Morning Brief ───────────────────────────────────────────────────────

function getDemoMorningBrief(): { message: string; alerts: Alert[] } {
  const alerts: Alert[] = [
    {
      priority: 'high',
      message: 'Invoice for $28,000 on the Fitzroy job (14 Merri St) is 3 days overdue. The Hendersons have not paid.',
      action: 'Chase payment',
      entity_id: '00000000-0000-0000-0000-000000000061',
      entity_type: 'invoice',
    },
    {
      priority: 'high',
      message: '2 variations on the Fitzroy job are waiting for approval — kitchen benchtop upgrade ($3,200) and extra GPO points ($680).',
      action: 'Review variations',
      entity_id: '00000000-0000-0000-0000-000000000010',
      entity_type: 'job',
    },
    {
      priority: 'medium',
      message: 'Toorak quote for $127,500 was sent to Tom Caruso 5 days ago with no response yet.',
      action: 'Follow up',
      entity_id: '00000000-0000-0000-0000-000000000041',
      entity_type: 'quote',
    },
    {
      priority: 'low',
      message: '3 active jobs · 2 pending variations · 1 overdue invoice. Brunswick job at 52 Bendigo St is still in quoting.',
      entity_type: 'job',
    },
  ]

  const message =
    'Good morning, Dave. Here\'s what needs your attention today. You have an overdue invoice on the Fitzroy job, two variations waiting on approval, and a quote sent to Tom Caruso last week with no reply.'

  return { message, alerts }
}

// ─── Live Supabase Morning Brief ──────────────────────────────────────────────

async function getLiveMorningBrief(
  builderId: string,
  supabaseUrl: string,
  serviceRoleKey: string
): Promise<{ message: string; alerts: Alert[] }> {
  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const alerts: Alert[] = []

  // Overdue invoices: sent invoices with due_date in the past
  const { data: invoices } = await supabase
    .from('invoices')
    .select('id, job_id, amount, due_date, status')
    .eq('builder_id', builderId)
    .eq('status', 'sent')
    .lt('due_date', new Date().toISOString().split('T')[0])

  if (invoices && invoices.length > 0) {
    for (const inv of invoices as Invoice[]) {
      const { data: job } = await supabase
        .from('jobs')
        .select('address')
        .eq('id', inv.job_id)
        .single()

      const address = (job as { address: string } | null)?.address ?? 'unknown job'
      const dueRelative = inv.due_date ? relativeDate(inv.due_date) : 'recently'
      alerts.push({
        priority: 'high',
        message: `Invoice for ${formatAUD(inv.amount)} on ${address} was due ${dueRelative} and has not been paid.`,
        action: 'Chase payment',
        entity_id: inv.id,
        entity_type: 'invoice',
      })
    }
  }

  // Pending variations grouped by job
  const { data: variations } = await supabase
    .from('variations')
    .select('id, job_id, title, amount, status, created_at')
    .eq('builder_id', builderId)
    .eq('status', 'pending')

  if (variations && variations.length > 0) {
    const typedVariations = variations as Variation[]
    // Group by job
    const byJob = new Map<string, Variation[]>()
    for (const v of typedVariations) {
      const existing = byJob.get(v.job_id) ?? []
      existing.push(v)
      byJob.set(v.job_id, existing)
    }

    for (const [jobId, vars] of Array.from(byJob.entries())) {
      const { data: job } = await supabase
        .from('jobs')
        .select('address')
        .eq('id', jobId)
        .single()

      const address = (job as { address: string } | null)?.address ?? 'unknown job'
      const count = vars.length
      const totalAmount = vars.reduce((sum: number, v: Variation) => sum + (v.amount ?? 0), 0)
      const priority: 'high' | 'medium' = count >= 2 ? 'high' : 'medium'

      alerts.push({
        priority,
        message:
          count === 1
            ? `1 variation on ${address} is waiting for approval — ${vars[0].title} (${formatAUD(vars[0].amount ?? 0)}).`
            : `${count} variations on ${address} are waiting for approval, totalling ${formatAUD(totalAmount)}.`,
        action: 'Review variations',
        entity_id: jobId,
        entity_type: 'job',
      })
    }
  }

  // Stale sent quotes (sent more than 3 days ago with no response)
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  const { data: staleQuotes } = await supabase
    .from('quotes')
    .select('id, job_id, total_cost, sent_at')
    .eq('builder_id', builderId)
    .eq('status', 'sent')
    .lt('sent_at', threeDaysAgo)

  if (staleQuotes && staleQuotes.length > 0) {
    for (const quote of staleQuotes as Quote[]) {
      const { data: job } = await supabase
        .from('jobs')
        .select('address')
        .eq('id', quote.job_id)
        .single()

      const address = (job as { address: string } | null)?.address ?? 'unknown job'
      const sentRelative = quote.sent_at ? relativeDate(quote.sent_at) : 'recently'

      alerts.push({
        priority: 'medium',
        message: `Quote for ${formatAUD(quote.total_cost ?? 0)} on ${address} was sent ${sentRelative} with no response yet.`,
        action: 'Follow up',
        entity_id: quote.id,
        entity_type: 'quote',
      })
    }
  }

  // Active jobs summary
  const { data: activeJobs } = await supabase
    .from('jobs')
    .select('id, address, status')
    .eq('builder_id', builderId)
    .in('status', ['active', 'quoting', 'quoted'])

  if (activeJobs && activeJobs.length > 0) {
    const typedJobs = activeJobs as Job[]
    const activeCount = typedJobs.filter((j: Job) => j.status === 'active').length
    const quotingCount = typedJobs.filter((j: Job) => j.status === 'quoting').length
    const quotedCount = typedJobs.filter((j: Job) => j.status === 'quoted').length

    const parts: string[] = []
    if (activeCount > 0) parts.push(`${activeCount} active job${activeCount !== 1 ? 's' : ''}`)
    if (quotingCount > 0) parts.push(`${quotingCount} in quoting`)
    if (quotedCount > 0) parts.push(`${quotedCount} quoted`)

    alerts.push({
      priority: 'low',
      message: parts.join(' · '),
      entity_type: 'job',
    })
  }

  // Build summary message
  const highCount = alerts.filter((a) => a.priority === 'high').length
  const medCount = alerts.filter((a) => a.priority === 'medium').length

  let message = 'Good morning. Here\'s what needs your attention today.'
  if (highCount === 0 && medCount === 0) {
    message = 'Good morning. No urgent items — things are looking clear today.'
  } else if (highCount > 0) {
    message = `Good morning. You have ${highCount} item${highCount !== 1 ? 's' : ''} that need${highCount === 1 ? 's' : ''} immediate attention.`
  }

  return { message, alerts }
}

// ─── Create Worker ────────────────────────────────────────────────────────────

interface CreateWorkerParams {
  builder_id: string
  name: string
  role: string
  email?: string
  phone?: string
}

interface CreateWorkerResult {
  worker: Worker
  invite_url: string
  modal_event: WorkerModalEvent
}

async function createWorker(params: CreateWorkerParams): Promise<CreateWorkerResult> {
  const { builder_id, name, role, email, phone } = params

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (supabaseUrl && serviceRoleKey) {
    // Live mode: insert into Supabase
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: workerRow, error } = await supabase
      .from('workers')
      .insert({
        builder_id,
        name: name.trim(),
        role: role.trim().toLowerCase(),
        email: email?.trim() ?? null,
        phone: phone?.trim() ?? null,
        status: 'invited' as const,
      })
      .select()
      .single()

    if (error || !workerRow) {
      throw new Error(error?.message ?? 'Failed to insert worker')
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    const invite_url = `${appUrl}/join/${workerRow.invite_token ?? 'unknown'}`

    return {
      worker: workerRow as Worker,
      invite_url,
      modal_event: { type: 'open_worker_modal', worker_id: workerRow.id },
    }
  }

  // Demo mode: return a mock worker with a fake UUID and invite URL
  const fakeId = randomUUID()
  const fakeToken = 'demo-invite-token'
  const worker: Worker = {
    id: fakeId,
    builder_id,
    name: name.trim(),
    role: role.trim().toLowerCase(),
    email: email?.trim() ?? null,
    phone: phone?.trim() ?? null,
    status: 'invited',
    invite_token: fakeToken,
    created_at: new Date().toISOString(),
  }

  return {
    worker,
    invite_url: `http://localhost:3000/join/${fakeToken}`,
    modal_event: { type: 'open_worker_modal', worker_id: fakeId },
  }
}

// ─── Create Job ───────────────────────────────────────────────────────────────

interface CreateJobParams {
  builder_id: string
  address: string
  client_name?: string
  force_create?: boolean
}

interface CreateJobResult {
  job?: Job
  duplicate?: boolean
  existing_job?: Job
  event: UploadPanelEvent | DuplicateWarningEvent
}

// Seed job data — mirrors the demo seed in the database
const SEED_JOBS: Array<{ id: string; address: string; status: string; tokens: string[]; job_ref: string; client_name: string }> = [
  {
    id: '00000000-0000-0000-0000-000000000010',
    address: '14 Merri St, Fitzroy VIC 3065',
    status: 'active',
    tokens: ['14 merri st', '14 merri street'],
    job_ref: 'JOB-2025-001',
    client_name: 'Hendersons',
  },
  {
    id: '00000000-0000-0000-0000-000000000020',
    address: '8 Burnside Rd, Toorak VIC 3142',
    status: 'quoted',
    tokens: ['8 burnside'],
    job_ref: 'JOB-2025-002',
    client_name: 'Tom Caruso',
  },
  {
    id: '00000000-0000-0000-0000-000000000030',
    address: '52 Bendigo St, Brunswick VIC 3056',
    status: 'quoting',
    tokens: ['52 bendigo'],
    job_ref: 'JOB-2025-003',
    client_name: 'Brunswick client',
  },
]

function normAddress(addr: string): string {
  return addr
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bplace\b/g, 'pl')
    .trim()
}

function findSeedDuplicate(address: string): (typeof SEED_JOBS)[number] | null {
  const norm = normAddress(address)
  for (const job of SEED_JOBS) {
    for (const token of job.tokens) {
      if (norm.includes(token)) return job
    }
  }
  return null
}

async function createJob(params: CreateJobParams): Promise<CreateJobResult> {
  const { builder_id, address, client_name, force_create } = params

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (supabaseUrl && serviceRoleKey) {
    // Live mode — query Supabase
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    if (!force_create) {
      // Duplicate check: case-insensitive ILIKE on first 3 address tokens
      const firstTokens = address.trim().split(/\s+/).slice(0, 3).join(' ')
      const { data: existing } = await supabase
        .from('jobs')
        .select('id, builder_id, client_id, address, status, job_type, notes, created_at, updated_at')
        .eq('builder_id', builder_id)
        .neq('status', 'archived')
        .ilike('address', `%${firstTokens}%`)
        .limit(1)
        .maybeSingle()

      if (existing) {
        const existingJob = existing as Job
        return {
          duplicate: true,
          existing_job: existingJob,
          event: { type: 'show_duplicate_warning', job_id: existingJob.id },
        }
      }
    }

    // Insert new job
    const { data: jobRow, error } = await supabase
      .from('jobs')
      .insert({
        builder_id,
        address: address.trim(),
        status: 'quoting' as const,
        client_id: null,
        job_type: null,
        notes: client_name ? `Client: ${client_name}` : null,
      })
      .select()
      .single()

    if (error || !jobRow) {
      throw new Error(error?.message ?? 'Failed to insert job')
    }

    const newJob = jobRow as Job
    return {
      job: newJob,
      event: { type: 'open_upload_panel', job_id: newJob.id },
    }
  }

  // Demo mode
  if (!force_create) {
    const duplicate = findSeedDuplicate(address)
    if (duplicate) {
      const existingJob: Job = {
        id: duplicate.id,
        builder_id,
        client_id: null,
        address: duplicate.address,
        status: duplicate.status as Job['status'],
        job_type: null,
        notes: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      return {
        duplicate: true,
        existing_job: existingJob,
        event: { type: 'show_duplicate_warning', job_id: duplicate.id },
      }
    }
  }

  // New job (demo mode)
  const fakeId = randomUUID()
  const newJob: Job = {
    id: fakeId,
    builder_id,
    client_id: null,
    address: address.trim(),
    status: 'quoting',
    job_type: null,
    notes: client_name ? `Client: ${client_name}` : null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  return {
    job: newJob,
    event: { type: 'open_upload_panel', job_id: fakeId },
  }
}

// ─── Intent Handlers ──────────────────────────────────────────────────────────

// ─── Demo Job Data ────────────────────────────────────────────────────────────

interface DemoJob {
  id: string
  address: string
  status: string
  client_name: string
  keywords: string[]
  client_keywords: string[]
  job_ref: string
  summary: string
  // Margin data (active/quoted jobs only)
  quoted_amount?: number
  projected_cost?: number
  cost_to_date?: number
  quoted_margin_percent?: number
  variation_impact?: number
}

const DEMO_JOBS: DemoJob[] = [
  {
    id: '00000000-0000-0000-0000-000000000010',
    address: '14 Merri St, Fitzroy',
    status: 'active',
    client_name: 'Henderson',
    keywords: ['fitzroy', 'merri', 'henderson'],
    client_keywords: ['henderson', 'hendersons'],
    job_ref: 'JOB-2025-001',
    summary: "Here's the status on the Fitzroy job — active, no outstanding variations. $28k invoice overdue 3 days.",
    quoted_amount: 142000,
    projected_cost: 158200,
    cost_to_date: 95500,
    quoted_margin_percent: 18,
    variation_impact: 4880,
  },
  {
    id: '00000000-0000-0000-0000-000000000020',
    address: '8 Burnside Rd, Toorak',
    status: 'quoted',
    client_name: 'Tom Caruso',
    keywords: ['toorak', 'burnside', 'caruso'],
    client_keywords: ['caruso', 'tom caruso'],
    job_ref: 'JOB-2025-002',
    summary: "The Toorak job is in quoted status — $127,500 quote sent to Tom Caruso 5 days ago, no response yet.",
    quoted_amount: 127500,
    projected_cost: 99450,
    cost_to_date: 0,
    quoted_margin_percent: 22,
    variation_impact: 0,
  },
  {
    id: '00000000-0000-0000-0000-000000000030',
    address: '52 Bendigo St, Brunswick',
    status: 'quoting',
    client_name: 'Brunswick client',
    keywords: ['brunswick', 'bendigo'],
    client_keywords: [],
    job_ref: 'JOB-2025-003',
    summary: "The Brunswick job at 52 Bendigo St is still in quoting — no quote sent yet.",
  },
]

function findDemoJob(entities: Record<string, string>): DemoJob | null {
  const ref = (entities.address ?? entities.job_name ?? '').toLowerCase()
  if (!ref) return null

  // 1. Exact job_ref match (e.g. "JOB-2025-001")
  for (const job of DEMO_JOBS) {
    if (ref.includes(job.job_ref.toLowerCase())) return job
  }

  // 2. Address/suburb keyword match
  for (const job of DEMO_JOBS) {
    for (const kw of job.keywords) {
      if (ref.includes(kw)) return job
    }
  }

  // 3. Client name token match
  for (const job of DEMO_JOBS) {
    for (const ck of job.client_keywords) {
      if (ref.includes(ck)) return job
    }
  }

  return null
}

// ─── Job Query Handler ────────────────────────────────────────────────────────

// Toorak job IDs (canonical and alias)
const TOORAK_JOB_ID = '00000000-0000-0000-0000-000000000020'
const TOORAK_QUOTE_ID = 'demo-quote-id-toorak'

function handleJobQuery(entities: Record<string, string>): ChatResponse {
  const job = findDemoJob(entities)

  if (!job) {
    const ref = entities.address ?? entities.job_name ?? ''
    return {
      intent: 'job_query',
      message: ref
        ? `I couldn't find a job matching "${ref}". You have jobs at Fitzroy (14 Merri St), Toorak (8 Burnside Rd), and Brunswick (52 Bendigo St).`
        : "Which job are you asking about? You have jobs at Fitzroy (14 Merri St), Toorak (8 Burnside Rd), and Brunswick (52 Bendigo St).",
    }
  }

  // Toorak job with sent quote — include activation suggestion
  if (job.id === TOORAK_JOB_ID && job.status === 'quoted') {
    return {
      intent: 'job_query',
      message:
        'The Toorak quote for $127,500 was sent to Tom Caruso 5 days ago. If Tom has verbally approved, you can activate the job now — this creates the milestone timeline and invoice schedule in one click.',
      event: {
        type: 'suggest_job_activation',
        job_id: TOORAK_JOB_ID,
        quote_id: TOORAK_QUOTE_ID,
      },
    }
  }

  return {
    intent: 'job_query',
    message: job.summary,
    event: {
      type: 'open_job_snapshot',
      job_id: job.id,
      job_address: job.address,
      job_status: job.status,
      client_name: job.client_name,
      job_ref: job.job_ref,
    },
  }
}

function applyVariationState(variation: DemoVariation): DemoVariation {
  const override = demoVariationState.get(variation.id)
  if (!override) return variation
  return {
    ...variation,
    status: override.status as DemoVariation['status'],
    approved_at: override.approved_at ?? null,
    approved_by: override.approved_by ?? null,
  }
}

function handleVariationIntent(entities: Record<string, string>, builderId: string): ChatResponse {
  // Filter variations for this builder
  const builderVariations = DEMO_VARIATIONS
    .map(applyVariationState)
    .filter((v) => v.builder_id === builderId)

  // Filter for pending ones
  const pendingVariations = builderVariations.filter((v) => v.status === 'pending')

  if (pendingVariations.length === 0) {
    return {
      intent: 'variation',
      message: 'No pending variations right now — all scope changes are up to date.',
    }
  }

  // Surface the first pending variation with a follow-up question
  const first = pendingVariations[0]
  const count = pendingVariations.length
  const countPhrase = count === 1
    ? '1 pending variation'
    : `${count} pending variations`

  const message = `You have ${countPhrase} on the Fitzroy job that need a decision.\n\n${first.title} — $${first.amount.toLocaleString('en-AU')}. Approve or reject?`

  // Suppress unused variable warning from entities
  void entities

  return {
    intent: 'variation',
    message,
    variation: first,
    all_variations: pendingVariations,
    event: {
      type: 'show_variation',
      variation_id: first.id,
      job_id: first.job_id,
    },
  }
}

function handleInvoice(): ChatResponse {
  // The Fitzroy job has an overdue invoice of $28,000 — surface it and suggest a chase email
  return {
    intent: 'invoice',
    message: 'The Henderson invoice for $28,000 on the Fitzroy job (14 Merri St) is 3 days overdue. Want me to draft a follow-up email?',
    event: {
      type: 'suggest_email_draft',
      job_id: '00000000-0000-0000-0000-000000000010',
      intent_hint: 'invoice',
    },
  }
}

// ─── Email Draft Handler ──────────────────────────────────────────────────────

// Map job references (from chat entities) to job IDs
function resolveJobId(jobReference: string | undefined): string | null {
  if (!jobReference) return null
  const ref = jobReference.toLowerCase()
  if (ref.includes('fitzroy') || ref.includes('merri') || ref.includes('henderson')) {
    return '00000000-0000-0000-0000-000000000010'
  }
  if (ref.includes('toorak') || ref.includes('burnside') || ref.includes('caruso')) {
    return '00000000-0000-0000-0000-000000000020'
  }
  if (ref.includes('brunswick') || ref.includes('bendigo')) {
    return '00000000-0000-0000-0000-000000000030'
  }
  return null
}

function handleEmailDraft(entities: Record<string, string>): ChatResponse {
  const { recipient_name, job_reference, intent_hint } = entities
  const resolvedJobId = resolveJobId(job_reference)

  const recipientDisplay = recipient_name ?? 'the client'
  const jobDisplay = job_reference ? ` about the ${job_reference} job` : ''

  return {
    intent: 'email_draft',
    message: `Drafting an email to ${recipientDisplay}${jobDisplay}…`,
    event: {
      type: 'open_email_draft',
      job_id: resolvedJobId,
      recipient_name: recipient_name ?? null,
      intent_hint: intent_hint ?? 'general',
    },
  }
}

// ─── Email Sync Status Handler ────────────────────────────────────────────────

async function handleEmailSyncStatus(builderId: string): Promise<ChatResponse> {
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    const res = await fetch(`${appUrl}/api/email-sync/status?builder_id=${builderId}`)
    const data = await res.json() as {
      connected: boolean
      provider: 'gmail' | 'outlook' | null
      connected_at: string | null
      last_synced_at: string | null
      is_active: boolean
      emails_processed_today: number
      jobs_matched_today: number
    }

    if (!data.connected) {
      return {
        intent: 'email_sync_status',
        message: "Email sync is not connected. Go to Settings → Email sync to connect your Gmail or Outlook inbox.",
      }
    }

    const providerName = data.provider === 'gmail' ? 'Gmail' : 'Outlook'
    const connectedPhrase = data.connected_at ? ` Connected ${data.connected_at}.` : ''
    const syncPhrase = data.last_synced_at ? ` Last synced ${data.last_synced_at}.` : ''
    const todayPhrase =
      data.emails_processed_today > 0
        ? ` Today: ${data.emails_processed_today} email${data.emails_processed_today !== 1 ? 's' : ''} processed, ${data.jobs_matched_today} matched to jobs.`
        : ' No emails processed today yet.'

    return {
      intent: 'email_sync_status',
      message: `${providerName} is connected and monitoring your inbox.${connectedPhrase}${syncPhrase}${todayPhrase}`,
    }
  } catch {
    return {
      intent: 'email_sync_status',
      message: 'Email sync status is unavailable right now. Try again in a moment.',
    }
  }
}

// ─── Simulate Email Handler ───────────────────────────────────────────────────

async function handleSimulateEmail(builderId: string): Promise<ChatResponse> {
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    const res = await fetch(`${appUrl}/api/email-sync/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ builder_id: builderId, scenario: 'invoice_query' }),
    })
    const data = await res.json() as {
      matched: boolean
      job_id: string | null
      job_address: string | null
      intent: string
      confidence: number
      communication_id: string | null
      suggested_action: {
        type: string
        description: string
        draft?: { subject: string; body: string }
      } | null
      auto_logged: boolean
    }

    if (!data.matched) {
      return {
        intent: 'simulate_email',
        message: 'Simulated email received but could not be matched to any active job.',
      }
    }

    const address = data.job_address ?? 'an active job'
    const preview = 'Hi Dave, just checking on the invoice — can we pay via bank transfer?'

    return {
      intent: 'simulate_email',
      message: `Simulated inbound email matched to ${address}. Intent: ${data.intent}. Email has been logged to communication history.`,
      event: {
        type: 'inbound_email_alert',
        email: {
          from: 'henderson@email.com',
          subject: 'Re: Invoice — 14 Merri St, Fitzroy',
          preview,
          received_display: 'just now',
        },
        job_address: address,
        intent: data.intent,
        suggested_action: data.suggested_action,
      },
    }
  } catch {
    return {
      intent: 'simulate_email',
      message: 'Could not simulate email — the email sync endpoint is unavailable.',
    }
  }
}

function handleMarginQuery(): ChatResponse {
  const activeJobs = DEMO_JOBS.filter(
    (j) => (j.status === 'active' || j.status === 'quoted') && j.quoted_amount !== undefined
  )

  if (activeJobs.length === 0) {
    return {
      intent: 'margin_query',
      message: 'No active jobs with margin data right now.',
    }
  }

  const marginJobs: MarginJob[] = activeJobs.map((job) => {
    const quoted = job.quoted_amount!
    const cost = job.projected_cost!
    const marginAmt = quoted - cost
    const marginPct = (marginAmt / quoted) * 100
    return {
      id: job.id,
      job_ref: job.job_ref,
      address: job.address,
      status: job.status,
      quoted_amount: quoted,
      projected_cost: cost,
      margin_amount: marginAmt,
      margin_percent: parseFloat(marginPct.toFixed(1)),
      quoted_margin_percent: job.quoted_margin_percent!,
      cost_to_date: job.cost_to_date ?? 0,
      variation_impact: job.variation_impact ?? 0,
    }
  }).sort((a, b) => a.margin_percent - b.margin_percent)

  const bleeding = marginJobs.filter((j) => j.margin_percent < 10)
  const healthy = marginJobs.filter((j) => j.margin_percent >= 15)

  let message: string
  if (bleeding.length > 0) {
    const worst = bleeding[0]
    const isNeg = worst.margin_percent < 0
    message = `The ${worst.address.split(',')[0]} job is ${isNeg ? 'underwater' : 'at risk'} — margin is tracking at ${isNeg ? '–' : ''}${Math.abs(worst.margin_percent).toFixed(1)}% against the quoted ${worst.quoted_margin_percent}%. Variations and cost overruns have added $${worst.variation_impact.toLocaleString('en-AU')} to projected spend.`
    if (healthy.length > 0) {
      message += ` The Toorak quote is holding at ${healthy[0].margin_percent.toFixed(1)}%.`
    }
  } else {
    message = `Margins are looking ${healthy.length === marginJobs.length ? 'healthy' : 'acceptable'} across your ${marginJobs.length} job${marginJobs.length !== 1 ? 's' : ''}. Keep an eye on variations.`
  }

  return {
    intent: 'margin_query',
    message,
    margin_jobs: marginJobs,
  }
}

function handleUnknown(): ChatResponse {
  return {
    intent: 'unknown',
    message: 'I can help with jobs, quotes, workers, variations, and invoices. Try:\n• "whats on today" — daily brief\n• "new job at 12 Smith St Richmond" — start a job\n• "list my jobs" — see all active jobs\n• "add a worker called Tom, carpenter" — invite crew\n• "log a variation on [address]" — record a change',
  }
}

async function smartFallback(
  message: string,
  builderId: string,
  anthropic: Anthropic
): Promise<ChatResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  let jobLines = '- 14 Merri St, Fitzroy VIC 3065 (active, JOB-2025-001)\n- 8 Burnside Rd, Toorak VIC 3142 (quoted, JOB-2025-002)\n- 52 Bendigo St, Brunswick VIC 3056 (quoting, JOB-2025-003)'
  let workerLines = '- Jack Thompson (Carpenter)\n- Mick Reynolds (Plumber)'

  if (supabaseUrl && serviceRoleKey) {
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
    const [{ data: jobs }, { data: workers }] = await Promise.all([
      supabase.from('jobs').select('address, status, job_ref').eq('builder_id', builderId).not('status', 'eq', 'archived').limit(10),
      supabase.from('workers').select('name, role').eq('builder_id', builderId).limit(20),
    ])
    jobLines = jobs?.length
      ? (jobs as Array<{ address: string; status: string; job_ref: string | null }>)
          .map(j => `- ${j.address} (${j.status}${j.job_ref ? ', ' + j.job_ref : ''})`).join('\n')
      : 'No active jobs yet.'
    workerLines = workers?.length
      ? (workers as Array<{ name: string; role: string }>).map(w => `- ${w.name} (${w.role})`).join('\n')
      : 'No workers yet.'
  }

  const systemPrompt = `You are WorkA — an AI operations manager for Australian residential builders. Answer in plain English. Be direct and brief (builders are busy on site).

Active jobs:
${jobLines}

Crew:
${workerLines}

Actions available — tell the builder to type these if they want to act:
- "whats on today" — daily brief and alerts
- "new job at [address]" — create a job
- "add [name], they're a [trade]" — invite a crew member
- "show my jobs" / "show my team" — lists
- "log a variation on [address]" — record a scope change
- "invoice for [stage] on [address]" — create an invoice
- "email [client] about [topic]" — draft a client email
- "how's my margin" — margin overview

Rules: never invent data you don't have. Keep responses under 4 sentences unless listing items. All amounts in AUD.`

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
    })
    const text = resp.content[0].type === 'text' ? resp.content[0].text : null
    return {
      intent: 'unknown',
      message: text ?? handleUnknown().message,
    }
  } catch {
    return handleUnknown()
  }
}

// ─── POST Handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse<ChatResponse>> {
  try {
    const body = (await request.json()) as ChatRequestBody
    const message = body.message?.trim()
    const builderId = body.builder_id ?? '00000000-0000-0000-0000-000000000001'

    if (!message) {
      return NextResponse.json(
        { intent: 'unknown', message: 'Please type a message.' },
        { status: 400 }
      )
    }

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      // No API key — keyword-based fallbacks for demo mode
      const lower = message.toLowerCase()
      if (
        lower.includes('today') ||
        lower.includes('brief') ||
        lower.includes('on today') ||
        lower.includes('morning') ||
        lower.includes('what') ||
        lower.includes('status')
      ) {
        const demo = getDemoMorningBrief()
        return NextResponse.json({
          intent: 'morning_brief',
          message: demo.message,
          alerts: demo.alerts,
        })
      }
      // Demo new_job: detect "new job at <address>" or "job at <address>"
      const newJobMatch = lower.match(/(?:new job|job)\s+at\s+(.+?)(?:\s+help|\s+quote|\s+start|$)/i)
      if (newJobMatch ?? lower.includes('create job anyway')) {
        const demoAddress = newJobMatch ? newJobMatch[1].trim() : 'unknown address'
        const forceCreate = body.force_create === true || lower.includes('create job anyway')
        const result = await createJob({
          builder_id: builderId,
          address: demoAddress,
          force_create: forceCreate,
        })
        if (result.duplicate && result.existing_job) {
          return NextResponse.json({
            intent: 'new_job',
            message: `Heads up — you've already got a job at ${result.existing_job.address} (currently ${result.existing_job.status}). Want to open that job instead?`,
            duplicate: true,
            existing_job: result.existing_job,
            event: result.event,
          })
        }
        return NextResponse.json({
          intent: 'new_job',
          message: `New job at ${result.job!.address} created. Upload your plans to start the quote.`,
          job: result.job,
          event: result.event,
        })
      }
      // Demo add_worker: detect "add <name>" pattern
      const addMatch = lower.match(/add\s+(\w+)/)
      const roleMatch = lower.match(/(?:he(?:'s|s)|she(?:'s|s)|is\s+a|a)\s+(\w+)/i)
      if (addMatch) {
        const demoName = addMatch[1].charAt(0).toUpperCase() + addMatch[1].slice(1)
        const demoRole = roleMatch ? roleMatch[1].toLowerCase() : 'worker'
        const result = await createWorker({
          builder_id: builderId,
          name: demoName,
          role: demoRole,
        })
        return NextResponse.json({
          intent: 'add_worker',
          message: `Added ${demoName} as a ${result.worker.role.charAt(0).toUpperCase() + result.worker.role.slice(1)}. Invite link is ready — send it in two taps.`,
          worker: result.worker,
          invite_url: result.invite_url,
          event: result.modal_event,
        })
      }
      // Demo variation: detect variation-related keywords
      if (
        lower.includes('variation') ||
        lower.includes('variations') ||
        lower.includes('change order') ||
        lower.includes('scope change') ||
        lower.includes('show me the variations')
      ) {
        return NextResponse.json(handleVariationIntent({}, builderId))
      }
      // Demo invoice: detect invoice/payment keywords
      if (
        lower.includes('invoice') ||
        lower.includes('payment') ||
        lower.includes('overdue') ||
        lower.includes('chase payment') ||
        lower.includes('chase the')
      ) {
        return NextResponse.json(handleInvoice())
      }
      // Demo email_draft: detect email/draft/follow-up keywords
      if (
        lower.includes('email') ||
        lower.includes('draft') ||
        lower.includes('follow up') ||
        lower.includes('follow-up') ||
        lower.includes('chase') ||
        lower.includes('message the') ||
        lower.includes('send a message')
      ) {
        // Try to detect recipient and job context from message
        const fitzroyMatch = lower.includes('henderson') || lower.includes('fitzroy') || lower.includes('merri')
        const toorakMatch = lower.includes('caruso') || lower.includes('tom') || lower.includes('toorak') || lower.includes('burnside')
        const invoiceHint = lower.includes('invoice') || lower.includes('payment') || lower.includes('chase')
        const quoteHint = lower.includes('quote') || lower.includes('follow up') || lower.includes('follow-up')

        const jobId = fitzroyMatch
          ? '00000000-0000-0000-0000-000000000010'
          : toorakMatch
            ? '00000000-0000-0000-0000-000000000020'
            : null
        const recipientName = fitzroyMatch ? 'the Hendersons' : toorakMatch ? 'Tom Caruso' : null
        const hint = invoiceHint ? 'invoice' : quoteHint ? 'quote_followup' : 'general'
        const recipientDisplay = recipientName ?? 'the client'

        return NextResponse.json({
          intent: 'email_draft',
          message: `Drafting an email to ${recipientDisplay}…`,
          event: {
            type: 'open_email_draft',
            job_id: jobId,
            recipient_name: recipientName,
            intent_hint: hint,
          },
        })
      }
      // Demo email_sync_status: detect "email connected", "email sync status" etc
      if (
        (lower.includes('email') && lower.includes('connected')) ||
        (lower.includes('email') && lower.includes('sync')) ||
        (lower.includes('gmail') && lower.includes('connected')) ||
        lower === 'email sync status'
      ) {
        const result = await handleEmailSyncStatus(builderId)
        return NextResponse.json(result)
      }
      // Demo simulate_email: detect "simulate email", "test email sync" etc
      if (
        (lower.includes('simulate') && lower.includes('email')) ||
        (lower.includes('test') && lower.includes('email')) ||
        lower.includes('simulate email') ||
        lower.includes('test email sync')
      ) {
        const result = await handleSimulateEmail(builderId)
        return NextResponse.json(result)
      }
      // Demo margin_query: detect margin/profit/cost overrun keywords
      if (
        lower.includes('margin') ||
        lower.includes('profit') ||
        lower.includes('bleeding') ||
        lower.includes('losing money') ||
        lower.includes('cost overrun') ||
        lower.includes('which job is') ||
        (lower.includes('how') && lower.includes('margin'))
      ) {
        return NextResponse.json(handleMarginQuery())
      }
      // Demo job_query: detect known job keywords
      const demoJob = findDemoJob({ address: lower })
      if (demoJob) {
        return NextResponse.json(handleJobQuery({ address: lower }))
      }
      // Demo activate job: detect activation keywords
      if (
        lower.includes('activate') ||
        (lower.includes('toorak') && (lower.includes('go') || lower.includes('start') || lower.includes('kick off')))
      ) {
        return NextResponse.json({
          intent: 'job_query',
          message:
            'The Toorak quote for $127,500 was sent to Tom Caruso 5 days ago. If Tom has verbally approved, you can activate the job now — this creates the milestone timeline and invoice schedule in one click.',
          event: {
            type: 'suggest_job_activation',
            job_id: TOORAK_JOB_ID,
            quote_id: TOORAK_QUOTE_ID,
          },
        })
      }
      // Demo list_workers: detect staff/crew/team/worker listing
      if (
        lower.includes('staff') ||
        lower.includes('my workers') ||
        lower.includes('my crew') ||
        lower.includes('my team') ||
        lower.includes('list workers') ||
        lower.includes('show workers') ||
        (lower.includes('list') && lower.includes('worker')) ||
        (lower.includes('who') && (lower.includes('crew') || lower.includes('worker') || lower.includes('team')))
      ) {
        return NextResponse.json({
          intent: 'job_query',
          message: 'You have 2 workers on your crew:\n• Jack Thompson — Carpenter (on Fitzroy job)\n• Mick Reynolds — Plumber (on Fitzroy job)\n\nType "add [name], they\'re a [trade]" to invite someone new.',
        })
      }
      // Demo job listing: detect "quote", "list jobs", "all jobs", "my jobs"
      if (
        (lower.includes('quote') && !lower.includes('email') && !lower.includes('draft') && !lower.includes('follow')) ||
        lower.includes('my jobs') ||
        lower.includes('list jobs') ||
        lower.includes('all jobs') ||
        lower.includes('show jobs') ||
        lower.includes('what jobs')
      ) {
        return NextResponse.json({
          intent: 'job_query',
          message: 'You have 3 active jobs:\n• 14 Merri St, Fitzroy — active (JOB-2025-001)\n• 8 Burnside Rd, Toorak — quoted (JOB-2025-002)\n• 52 Bendigo St, Brunswick — quoting (JOB-2025-003)\n\nAsk me about any of them by address.',
        })
      }
      return NextResponse.json(handleUnknown())
    }

    // Pre-classify: worker/staff/crew listing — classify-intent has no intent for this
    const lowerMsg = message.toLowerCase()
    if (
      lowerMsg.includes('staff') ||
      lowerMsg.includes('my workers') ||
      lowerMsg.includes('my crew') ||
      lowerMsg.includes('my team') ||
      lowerMsg.includes('list workers') ||
      lowerMsg.includes('show workers') ||
      (lowerMsg.includes('list') && lowerMsg.includes('worker')) ||
      (lowerMsg.includes('who') && (lowerMsg.includes('crew') || lowerMsg.includes('worker') || lowerMsg.includes('team')))
    ) {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (supabaseUrl && serviceRoleKey) {
        const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
        const { data: workers } = await supabase
          .from('workers')
          .select('name, role, status')
          .eq('builder_id', builderId)
          .order('created_at', { ascending: false })
          .limit(20)
        if (workers && workers.length > 0) {
          const lines = (workers as Array<{ name: string; role: string; status: string }>)
            .map(w => `• ${w.name} — ${w.role} (${w.status})`)
            .join('\n')
          return NextResponse.json({
            intent: 'job_query',
            message: `You have ${workers.length} worker${workers.length === 1 ? '' : 's'} on your crew:\n${lines}\n\nType "add [name], they're a [trade]" to invite someone new.`,
          })
        }
        return NextResponse.json({
          intent: 'job_query',
          message: 'No workers on your crew yet. Type "add [name], they\'re a [trade]" to invite your first one.',
        })
      }
      return NextResponse.json({
        intent: 'job_query',
        message: 'You have 2 workers on your crew:\n• Jack Thompson — Carpenter (on Fitzroy job)\n• Mick Reynolds — Plumber (on Fitzroy job)\n\nType "add [name], they\'re a [trade]" to invite someone new.',
      })
    }

    const anthropic = new Anthropic({ apiKey })

    // Step 1: Classify intent
    const classified = await classifyIntent(message, anthropic)

    // Step 2: Route to handler
    if (classified.intent === 'morning_brief') {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

      const brief =
        supabaseUrl && serviceRoleKey
          ? await getLiveMorningBrief(builderId, supabaseUrl, serviceRoleKey)
          : getDemoMorningBrief()

      return NextResponse.json({
        intent: 'morning_brief',
        message: brief.message,
        alerts: brief.alerts,
      })
    }

    if (classified.intent === 'add_worker') {
      const { name, role, email, phone } = classified.entities
      if (!name || !role) {
        return NextResponse.json({
          intent: 'add_worker',
          message: `Got it — who are you adding and what's their trade? For example: "add Sarah she's a plumber"`,
        })
      }
      const result = await createWorker({
        builder_id: builderId,
        name,
        role,
        email,
        phone,
      })
      return NextResponse.json({
        intent: 'add_worker',
        message: `Added ${name} as a ${result.worker.role.charAt(0).toUpperCase() + result.worker.role.slice(1)}. Invite link is ready — send it in two taps.`,
        worker: result.worker,
        invite_url: result.invite_url,
        event: result.modal_event,
      })
    }

    if (classified.intent === 'new_job') {
      const address = classified.entities.address
      if (!address) {
        return NextResponse.json({
          intent: 'new_job',
          message: `Which address is this job at? For example: 'new job at 14 Smith St Fitzroy'`,
        })
      }
      const forceCreate = body.force_create === true
      const result = await createJob({
        builder_id: builderId,
        address,
        client_name: classified.entities.client_name,
        force_create: forceCreate,
      })
      if (result.duplicate && result.existing_job) {
        return NextResponse.json({
          intent: 'new_job',
          message: `Heads up — you've already got a job at ${result.existing_job.address} (currently ${result.existing_job.status}). Want to open that job instead?`,
          duplicate: true,
          existing_job: result.existing_job,
          event: result.event,
        })
      }
      return NextResponse.json({
        intent: 'new_job',
        message: `New job at ${result.job!.address} created. Upload your plans to start the quote.`,
        job: result.job,
        event: result.event,
      })
    }

    if (classified.intent === 'job_query') {
      // Live path: if no specific address, list all jobs from DB
      const address = classified.entities.address ?? classified.entities.job_name ?? ''
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!address && supabaseUrl && serviceRoleKey) {
        const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
        const { data: jobs } = await supabase
          .from('jobs')
          .select('id, address, status, job_ref')
          .eq('builder_id', builderId)
          .not('status', 'eq', 'archived')
          .order('created_at', { ascending: false })
          .limit(10)
        if (jobs && jobs.length > 0) {
          const lines = (jobs as Array<{ id: string; address: string; status: string; job_ref: string | null }>)
            .map(j => `• ${j.address} — ${j.status}${j.job_ref ? ` (${j.job_ref})` : ''}`)
            .join('\n')
          return NextResponse.json({
            intent: 'job_query',
            message: `You have ${jobs.length} active job${jobs.length === 1 ? '' : 's'}:\n${lines}\n\nAsk me about any of them by address.`,
          })
        }
        return NextResponse.json({
          intent: 'job_query',
          message: 'You don\'t have any active jobs yet. Try "new job at [address]" to get started.',
        })
      }
      return NextResponse.json(handleJobQuery(classified.entities))
    }

    if (classified.intent === 'variation') {
      return NextResponse.json(handleVariationIntent(classified.entities, builderId))
    }

    if (classified.intent === 'invoice') {
      return NextResponse.json(handleInvoice())
    }

    if (classified.intent === 'email_draft') {
      return NextResponse.json(handleEmailDraft(classified.entities))
    }

    if (classified.intent === 'email_sync_status') {
      const result = await handleEmailSyncStatus(builderId)
      return NextResponse.json(result)
    }

    if (classified.intent === 'simulate_email') {
      const result = await handleSimulateEmail(builderId)
      return NextResponse.json(result)
    }

    if (classified.intent === 'margin_query') {
      return NextResponse.json(handleMarginQuery())
    }

    return NextResponse.json(await smartFallback(message, builderId, anthropic))
  } catch (err) {
    console.error('[/api/chat] Error:', err)
    return NextResponse.json(
      { intent: 'unknown', message: 'Something went wrong — please try again.' },
      { status: 500 }
    )
  }
}
