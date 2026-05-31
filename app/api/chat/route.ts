import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import type {
  Invoice,
  Variation,
  Quote,
  Job,
  Worker,
  ExtractedAction,
} from '@/lib/types/database.types'
import { DEMO_VARIATIONS, demoVariationState, type DemoVariation } from '@/lib/variations-demo'
import { DEMO_ASSUMPTIONS } from '@/lib/assumptions-demo'
import { getDemoJobSnapshot } from '@/lib/job-snapshot-demo'

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

type ChatEvent =
  | WorkerModalEvent
  | UploadPanelEvent
  | DuplicateWarningEvent
  | OpenJobSnapshotEvent
  | ShowVariationEvent
  | OpenEmailDraftEvent
  | SuggestEmailDraftEvent
  | InboundEmailAlertEvent
  | SuggestJobActivationEvent

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

export interface StateChange {
  status: 'saved' | 'found' | 'warning' | 'blocked' | 'info'
  label: string
}

export interface JobListItem {
  id: string
  address: string
  status: string
  client_name?: string
  job_ref?: string | null
}

export interface WorkerListItem {
  id: string
  name: string
  role: string
  status: 'invited' | 'active' | 'inactive'
  email: string | null
  phone: string | null
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
  job_list?: JobListItem[]
  worker_list?: WorkerListItem[]
  state_changes?: StateChange[]
  // Single event preserved for backwards compat; primary path uses events[]
  event?: ChatEvent
  events?: ChatEvent[]
}

// ─── Action orchestration context ─────────────────────────────────────────────

interface OrchestrationContext {
  builder_id: string
  force_create: boolean
  // Resolved job context — set when a job is created or a duplicate is found
  resolved_job_id: string | null
  resolved_job: Job | null
  is_duplicate: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Multi-action extraction ──────────────────────────────────────────────────
//
// Replaces single-intent classification. Returns an ordered list of actions
// the builder wants executed, plus any context not tied to a specific action.
// Confidence < 50 on any action → action is skipped (not executed blindly).

const EXTRACT_ACTIONS_PROMPT = `You are an action extractor for WorkA — an AI operations manager for Australian residential builders.

Your job is to parse a builder's natural-language message and return ALL actions they are requesting, in priority order, as a JSON object.

### Output format (strict JSON, no other text)
{
  "actions": [
    {
      "type": "<action_type>",
      "entities": { "<key>": "<value>" },
      "confidence": <0-100>
    }
  ],
  "raw_context": { "<key>": "<value>" }
}

### Action types and entity schemas

1. morning_brief
   Trigger: asking about the day, today's schedule, what's on, daily summary
   Entities: {}

2. add_worker
   Trigger: adding, inviting, or creating a new crew member
   BULK: if multiple crew members are named in one message, return ONE add_worker action per person
   Entities: { name, role, email?, phone? }

3. create_job
   Trigger: creating a new job, new quote, new project at an address
   BULK: if the builder lists multiple addresses in one message, return ONE create_job action per address
   Entities: {
     address,           ← required: cleanest possible street address
     client_name?,      ← client's name if mentioned
     budget_hint?,      ← stated budget e.g. "around $380,000" → "380000"
     scope_notes?,      ← any scope description e.g. "rear extension", "kitchen reno"
     quote_deadline?,   ← ISO date YYYY-MM-DD if builder states when quote is needed (e.g. "by Friday", "before Easter"). Today: REPLACE_TODAY
     client_deadline?,  ← ISO date YYYY-MM-DD if client has a hard deadline (e.g. "council approval next week"). Today: REPLACE_TODAY
   }

4. job_query
   Trigger: asking about an existing job's status, timeline, workers
   Entities: { address?, job_name?, query_type? }

5. variation
   Trigger: creating, logging, or asking about a variation or change order
   Entities: { job_address?, title?, amount?, description? }

6. invoice
   Trigger: creating, sending, or asking about invoices or payments
   Entities: { job_address?, amount?, stage? }

7. email_draft
   Trigger: drafting or sending an email to a client or subcontractor
   Entities: { recipient_name?, job_reference?, intent_hint? }

8. email_sync_status
   Trigger: asking if email sync is connected
   Entities: {}

9. simulate_email
   Trigger: testing or simulating an inbound email
   Entities: {}

10. margin_query
    Trigger: asking about job margin, profit, cost overruns
    Entities: { job_address? }

11. open_upload_panel
    Trigger: builder explicitly asks to upload plans/files NOW (future intent)
    Entities: {}
    Note: only emit if the builder says they WANT to upload (e.g. "upload the plans", "I'll upload now")
    Do NOT emit for past uploads ("I've uploaded the plans", "I uploaded them") — use review_assumptions instead
    Do NOT emit if create_job is also present (create_job already opens the upload panel for new jobs)

12. review_assumptions
    Trigger: asking to see assumptions, unresolved items, what needs clarifying before the quote can be sent
    Also triggered by: "I've uploaded the plans" / "I uploaded the plans" / "plans are uploaded" — the builder
    has already uploaded and wants to know what's outstanding
    Do NOT trigger for uncertain language: "I've got plans somewhere", "I have plans but haven't uploaded",
    "plans are at the office", "I think I have the plans" — these mean plans are NOT yet uploaded
    Entities: {}

13. update_job_context
    Trigger: builder mentions new context about a job mid-conversation WITHOUT creating a new job
    (material changes, client preferences, timeline updates, scope changes on an existing job)
    Entities: { scope_notes?, budget_hint?, client_name? }
    Examples: "the client is leaning toward polished concrete", "budget has changed to $420k",
              "they want it done by August", "client now wants to add a deck"
    ONLY emit if the message is about an EXISTING job (not a new one)

15. add_task
    Trigger: adding a task, checklist item, or site instruction for staff on a job
    Entities: { job_address?, description, assignee_name? }
    Examples: "add task to 52 Bendigo: install footings", "assign Jack to dig the trenches at Brunswick"

16. upload_rates
    Trigger: wanting to upload past quotes, historical pricing, rate sheets, cost data, or supplier prices
    Entities: {}
    Examples: "upload past quotes", "how do I add my pricing database", "import my rates", "upload supplier prices"

18. client_lookup
    Trigger: asking if we've worked with a client before, client history, past jobs with someone
    Entities: { client_name }
    Examples: "have we done work for Sarah Jones before", "tell me what jobs we've had with the Hendersons"

19. meeting_prep
    Trigger: builder is about to meet a client, going into a meeting, needs a briefing on a client/job
    Entities: { client_name?, job_address? }
    Examples: "meeting with Sarah Jones in 15 minutes", "give me everything on the Fitzroy job before I meet them"

20. payment_risk
    Trigger: asking what might stop payment, which jobs are at risk of not getting paid, payment risk analysis, cashflow problems
    Entities: {}
    Examples: "what is most likely to stop me getting paid", "which jobs are at payment risk", "cashflow problems this month"

21. conflict_detected
    Trigger: the message contains two contradictory statements about the same entity
    Examples: "client approved the variation... actually don't mark it yet", "mark it complete... wait no it's still in progress"
    Return this INSTEAD of the contradictory actions — do not execute any of them
    Entities: { statement_a, statement_b, entity_type? }

22. worker_onboarding
    Trigger: a new worker is starting soon and needs to be set up, asking what a worker needs before starting on site
    Entities: { name?, start_date?, job_address? }
    Examples: "Jack starts Monday", "what does Sarah need before she can work on site", "new sparky starting next week"

23. roadmap
    Trigger: asking what is coming to WorkA, what features are planned, what's on the roadmap
    Entities: {}
    Examples: "what's coming to WorkA", "what features are planned", "roadmap", "what's next for WorkA"

24. team_notifications
    Trigger: asking about team messaging, group chat, notifying workers or crew, push notifications to staff
    Entities: {}
    Examples: "can I message my crew", "team chat", "notify workers", "push notifications to staff"

17. unknown
    Trigger: anything that doesn't fit the above
    Entities: {}

### raw_context
Capture any additional context not mapped to a specific action:
- timeline constraints ("needs to be done by Christmas", "quote by Friday")
- notes about scope or client preferences not covered by update_job_context
Keep values as short strings.

### Rules
- Return ALL actions the builder is requesting — never discard intent
- Order actions by logical dependency: create_job before open_upload_panel, create_job before review_assumptions
- "I've uploaded the plans" → review_assumptions (past tense = upload already done, surface what's next)
- "upload the plans" / "I need to upload" → open_upload_panel (future intent)
- "I've got plans somewhere" / "plans are at the office" → do NOT emit review_assumptions or open_upload_panel
- If a message has contradictory statements, emit conflict_detected INSTEAD of the conflicting actions
- If confidence is below 50 for an action, still include it but set confidence accurately
- For create_job: strip leading articles ("at", "for", "on") from address; strip trailing instructions
- For add_worker: normalise role to lowercase
- BULK: multiple create_job or add_worker actions allowed in one response when listing multiple items
- ONLY return valid JSON — no prose, no markdown, no explanation`

async function extractActions(
  message: string,
  anthropic: Anthropic
): Promise<ExtractedAction[]> {
  const todayIso = new Date().toISOString().split('T')[0]
  const systemPrompt = EXTRACT_ACTIONS_PROMPT.replace(/REPLACE_TODAY/g, todayIso)
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: 'user', content: message }],
  })

  const content = response.content[0]
  if (content.type !== 'text') {
    return [{ type: 'unknown', entities: {}, confidence: 0 }]
  }

  try {
    const cleaned = content.text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    const parsed = JSON.parse(cleaned) as { actions: ExtractedAction[]; raw_context: Record<string, string> }
    if (!Array.isArray(parsed.actions) || parsed.actions.length === 0) {
      return [{ type: 'unknown', entities: {}, confidence: 0 }]
    }
    // Filter out low-confidence actions silently — they are not executed
    return parsed.actions.filter((a) => (a.confidence ?? 0) >= 50)
  } catch {
    return [{ type: 'unknown', entities: {}, confidence: 0 }]
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
    'Good morning. Here\'s what needs your attention.\n\n' +
    'Suggested order:\n' +
    '1. Resolve Brunswick assumptions — 2 items are blocking the quote from being issued\n' +
    '2. Call the Hendersons — $28,000 invoice is 3 days overdue\n' +
    '3. Follow up Tom Caruso at Toorak — quote sent 5 days ago, no response\n' +
    '4. Approve 2 Fitzroy variations ($3,880 total)'

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

  const { data: variations } = await supabase
    .from('variations')
    .select('id, job_id, title, amount, status, created_at')
    .eq('builder_id', builderId)
    .eq('status', 'pending')

  if (variations && variations.length > 0) {
    const typedVariations = variations as Variation[]
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

  // Upcoming quote deadlines
  const twoDaysFromNow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const { data: upcomingDeadlines } = await supabase
    .from('jobs')
    .select('id, address, quote_deadline, status')
    .eq('builder_id', builderId)
    .not('quote_deadline', 'is', null)
    .lte('quote_deadline', twoDaysFromNow)
    .in('status', ['quoting', 'quoted'])

  if (upcomingDeadlines && upcomingDeadlines.length > 0) {
    for (const job of upcomingDeadlines as Array<{ id: string; address: string; quote_deadline: string; status: string }>) {
      const deadline = new Date(job.quote_deadline)
      const hoursLeft = (deadline.getTime() - Date.now()) / (1000 * 60 * 60)
      const urgency = hoursLeft < 0 ? 'OVERDUE' : hoursLeft < 24 ? `${Math.round(hoursLeft)}h left` : `${Math.round(hoursLeft / 24)} day(s)`
      alerts.push({
        priority: hoursLeft < 24 ? 'high' : 'medium',
        message: `Quote deadline for ${job.address} — ${urgency}.`,
        action: hoursLeft < 0 ? 'Check quote status' : 'Review quote',
        entity_id: job.id,
        entity_type: 'job',
      })
    }
  }

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

  const highCount = alerts.filter((a) => a.priority === 'high').length
  const medCount = alerts.filter((a) => a.priority === 'medium').length

  // Build suggested order from high-priority alerts
  const highAlerts = alerts.filter((a) => a.priority === 'high')
  const medAlerts = alerts.filter((a) => a.priority === 'medium')
  const priorityItems = [...highAlerts, ...medAlerts].slice(0, 4)

  let message = 'Good morning. Here\'s what needs your attention today.'
  if (alerts.length === 0) {
    message = 'Good morning. No jobs set up yet — type **"new job at [address]"** to create your first one, or **"add Jack, he\'s a carpenter"** to invite your crew.'
  } else if (highCount === 0 && medCount === 0) {
    message = 'Good morning. No urgent items today — everything is on track.'
  } else {
    const itemLines = priorityItems.map((a, i) => `${i + 1}. ${a.message}${a.action ? ' → ' + a.action : ''}`).join('\n')
    message = `Good morning. ${highCount > 0 ? `${highCount} item${highCount !== 1 ? 's' : ''} need${highCount === 1 ? 's' : ''} immediate attention.` : 'Here\'s what needs your attention.'}\n\nSuggested order:\n${itemLines}`
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
//
// Key change from v1: no longer returns early on duplicate.
// Returns { job, is_duplicate, existing_job? } so the orchestrator can
// switch context to the existing job and continue remaining actions.

interface CreateJobParams {
  builder_id: string
  address: string
  client_name?: string
  budget_hint?: string
  scope_notes?: string
  force_create?: boolean
}

interface CreateJobResult {
  job: Job
  is_duplicate: boolean
  existing_job?: Job
}

const SEED_JOBS: Array<{
  id: string
  address: string
  status: string
  tokens: string[]
  job_ref: string
  client_name: string
}> = [
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

function parseBudget(hint: string | undefined): number | null {
  if (!hint) return null
  const cleaned = hint.replace(/[,$\s]/g, '')
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

async function createJob(params: CreateJobParams): Promise<CreateJobResult> {
  const { builder_id, address, client_name, budget_hint, scope_notes, force_create } = params
  const budgetValue = parseBudget(budget_hint)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (supabaseUrl && serviceRoleKey) {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    if (!force_create) {
      const firstTokens = address.trim().split(/\s+/).slice(0, 3).join(' ')
      const { data: existing } = await supabase
        .from('jobs')
        .select('*')
        .eq('builder_id', builder_id)
        .neq('status', 'archived')
        .ilike('address', `%${firstTokens}%`)
        .limit(1)
        .maybeSingle()

      if (existing) {
        // Context-switch: return the existing job so orchestrator can continue
        // processing remaining actions against it — do NOT stop here
        return {
          job: existing as Job,
          is_duplicate: true,
          existing_job: existing as Job,
        }
      }
    }

    let clientId: string | null = null
    if (client_name && client_name.trim().length > 0) {
      const { data: newClient } = await supabase
        .from('clients')
        .insert({ builder_id, name: client_name.trim() })
        .select('id')
        .single()
      if (newClient) clientId = newClient.id as string
    }

    const { data: jobRow, error } = await supabase
      .from('jobs')
      .insert({
        builder_id,
        address: address.trim(),
        status: 'quoting' as const,
        client_id: clientId,
        job_type: null,
        notes: client_name ? `Client: ${client_name}` : null,
        budget_estimate: budgetValue,
        scope_notes: scope_notes ?? null,
      })
      .select()
      .single()

    if (error || !jobRow) {
      throw new Error(error?.message ?? 'Failed to insert job')
    }

    return { job: jobRow as Job, is_duplicate: false }
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
        budget_estimate: null,
        scope_notes: null,
        quote_deadline: null,
        client_deadline: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      return { job: existingJob, is_duplicate: true, existing_job: existingJob }
    }
  }

  const fakeId = randomUUID()
  const newJob: Job = {
    id: fakeId,
    builder_id,
    client_id: null,
    address: address.trim(),
    status: 'quoting',
    job_type: null,
    notes: client_name ? `Client: ${client_name}` : null,
    budget_estimate: budgetValue,
    scope_notes: scope_notes ?? null,
    quote_deadline: null,
    client_deadline: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  return { job: newJob, is_duplicate: false }
}

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

  for (const job of DEMO_JOBS) {
    if (ref.includes(job.job_ref.toLowerCase())) return job
  }
  for (const job of DEMO_JOBS) {
    for (const kw of job.keywords) {
      if (ref.includes(kw)) return job
    }
  }
  for (const job of DEMO_JOBS) {
    for (const ck of job.client_keywords) {
      if (ref.includes(ck)) return job
    }
  }

  return null
}

// ─── Individual action handlers ───────────────────────────────────────────────

const TOORAK_JOB_ID = '00000000-0000-0000-0000-000000000020'
const TOORAK_QUOTE_ID = 'demo-quote-id-toorak'

async function handleJobQuery(entities: Record<string, string>, builderId: string): Promise<Partial<ChatResponse>> {
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (sbUrl && sbKey) {
    const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
    const ref = (entities.address ?? entities.job_name ?? entities.job_ref ?? '').trim()

    if (ref) {
      // Search by address
      const { data: jobs } = await sb
        .from('jobs')
        .select('id, address, status, job_ref')
        .eq('builder_id', builderId)
        .ilike('address', `%${ref}%`)
        .not('status', 'eq', 'archived')
        .limit(3)

      if (jobs && jobs.length === 1) {
        const j = jobs[0] as { id: string; address: string; status: string; job_ref: string | null }
        return {
          message: `Opening ${j.address}…`,
          event: { type: 'open_job_snapshot', job_id: j.id, job_address: j.address, job_status: j.status },
        }
      }
      if (jobs && jobs.length > 1) {
        const list = (jobs as Array<{ address: string; status: string }>).map(j => `• ${j.address} — ${j.status}`).join('\n')
        return { message: `Found ${jobs.length} jobs matching "${ref}":\n${list}\n\nBe more specific — which one?` }
      }
    }

    // No match — list real jobs
    const { data: allJobs } = await sb
      .from('jobs')
      .select('id, address, status, job_ref')
      .eq('builder_id', builderId)
      .not('status', 'eq', 'archived')
      .order('created_at', { ascending: false })
      .limit(10)

    if (!allJobs || allJobs.length === 0) {
      return { message: 'No active jobs yet. Type "new job at [address]" to create one.' }
    }

    const list = (allJobs as Array<{ address: string; status: string }>).map(j => `• ${j.address} — ${j.status}`).join('\n')
    return {
      message: ref
        ? `No job found matching "${ref}". Your active jobs:\n${list}`
        : `Which job are you asking about? Your active jobs:\n${list}`,
      job_list: (allJobs as Array<{ id: string; address: string; status: string; job_ref: string | null }>)
        .map(j => ({ id: j.id, address: j.address, status: j.status, job_ref: j.job_ref })),
    }
  }

  // Demo fallback
  const job = findDemoJob(entities)
  if (!job) {
    return {
      message: entities.address
        ? `No job found matching "${entities.address}". Your active jobs:\n• 14 Merri St, Fitzroy\n• 8 Burnside Rd, Toorak\n• 52 Bendigo St, Brunswick`
        : 'Which job are you asking about?',
      job_list: DEMO_JOB_LIST,
    }
  }
  if (job.id === TOORAK_JOB_ID && job.status === 'quoted') {
    return {
      message: 'The Toorak quote for $127,500 was sent to Tom Caruso 5 days ago. If Tom has verbally approved, you can activate the job now.',
      event: { type: 'suggest_job_activation', job_id: TOORAK_JOB_ID, quote_id: TOORAK_QUOTE_ID },
    }
  }
  return {
    message: job.summary,
    event: { type: 'open_job_snapshot', job_id: job.id, job_address: job.address, job_status: job.status, client_name: job.client_name, job_ref: job.job_ref },
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

async function handleVariationIntent(entities: Record<string, string>, builderId: string): Promise<Partial<ChatResponse>> {
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (sbUrl && sbKey) {
    const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
    const { data: vars } = await sb
      .from('variations')
      .select('id, job_id, title, description, amount, status, created_at')
      .eq('builder_id', builderId)
      .in('status', ['pending', 'draft'])
      .order('created_at', { ascending: true })
      .limit(10)

    if (!vars || vars.length === 0) {
      return { message: 'No pending variations right now — all scope changes are approved or up to date.' }
    }

    const pending = (vars as Array<{ id: string; job_id: string; title: string; description: string; amount: number | null; status: string; created_at: string }>)
      .filter(v => v.status === 'pending')

    if (pending.length === 0) {
      return { message: `${vars.length} variation${vars.length !== 1 ? 's' : ''} in draft — not yet sent for approval.` }
    }

    const first = pending[0]
    const { data: job } = await sb.from('jobs').select('address').eq('id', first.job_id).single()
    const addr = (job as { address: string } | null)?.address ?? 'a job'
    const countPhrase = pending.length === 1 ? '1 pending variation' : `${pending.length} pending variations`
    const amtDisplay = first.amount ? `$${first.amount.toLocaleString('en-AU')}` : 'amount TBD'

    return {
      message: `You have ${countPhrase} on ${addr} that need a decision.\n\n${first.title} — ${amtDisplay}. Approve or reject?`,
      event: { type: 'show_variation', variation_id: first.id, job_id: first.job_id },
    }
  }

  // Demo fallback
  void entities
  const builderVariations = DEMO_VARIATIONS.map(applyVariationState).filter((v) => v.builder_id === builderId)
  const pendingVariations = builderVariations.filter((v) => v.status === 'pending')

  if (pendingVariations.length === 0) {
    return { message: 'No pending variations right now — all scope changes are up to date.' }
  }

  const first = pendingVariations[0]
  const count = pendingVariations.length
  const countPhrase = count === 1 ? '1 pending variation' : `${count} pending variations`
  return {
    message: `You have ${countPhrase} on the Fitzroy job that need a decision.\n\n${first.title} — $${first.amount.toLocaleString('en-AU')}. Approve or reject?`,
    variation: first,
    all_variations: pendingVariations,
    event: { type: 'show_variation', variation_id: first.id, job_id: first.job_id },
  }
}

async function handleInvoice(builderId: string): Promise<Partial<ChatResponse>> {
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (sbUrl && sbKey) {
    const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
    const { data: invoices } = await sb
      .from('invoices')
      .select('id, job_id, amount, status, due_date, sent_at')
      .eq('builder_id', builderId)
      .in('status', ['overdue', 'sent', 'draft'])
      .order('due_date', { ascending: true })
      .limit(5)

    if (!invoices || invoices.length === 0) {
      return { message: 'No outstanding invoices right now. Type "invoice for [stage] on [address]" to create one.' }
    }

    const overdues = (invoices as Array<{ id: string; job_id: string; amount: number; status: string; due_date: string | null; sent_at: string | null }>)
      .filter(i => i.status === 'overdue')

    if (overdues.length > 0) {
      const inv = overdues[0]
      const { data: job } = await sb.from('jobs').select('address').eq('id', inv.job_id).single()
      const addr = (job as { address: string } | null)?.address ?? 'a job'
      const daysOverdue = inv.due_date
        ? Math.max(0, Math.floor((Date.now() - new Date(inv.due_date).getTime()) / 86400000))
        : null
      const overdueLabel = daysOverdue !== null ? ` ${daysOverdue} day${daysOverdue !== 1 ? 's' : ''} overdue` : ' overdue'
      return {
        message: `$${inv.amount.toLocaleString('en-AU')} invoice on ${addr} is${overdueLabel}. Want me to draft a follow-up email?`,
        event: { type: 'suggest_email_draft', job_id: inv.job_id, intent_hint: 'invoice' },
      }
    }

    const sent = (invoices as Array<{ id: string; job_id: string; amount: number; status: string }>).filter(i => i.status === 'sent')
    if (sent.length > 0) {
      const total = sent.reduce((s, i) => s + i.amount, 0)
      return { message: `${sent.length} invoice${sent.length !== 1 ? 's' : ''} outstanding totalling $${total.toLocaleString('en-AU')} — awaiting payment.` }
    }

    return { message: `${invoices.length} invoice${invoices.length !== 1 ? 's' : ''} in draft. Send them when you're ready.` }
  }

  // Demo fallback
  return {
    message: 'The Henderson invoice for $28,000 on the Fitzroy job (14 Merri St) is 3 days overdue. Want me to draft a follow-up email?',
    event: { type: 'suggest_email_draft', job_id: '00000000-0000-0000-0000-000000000010', intent_hint: 'invoice' },
  }
}

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

function handleEmailDraft(entities: Record<string, string>): Partial<ChatResponse> {
  const { recipient_name, job_reference, intent_hint } = entities
  const resolvedJobId = resolveJobId(job_reference)
  const recipientDisplay = recipient_name ?? 'the client'
  const jobDisplay = job_reference ? ` about the ${job_reference} job` : ''

  return {
    message: `I'll draft an email to ${recipientDisplay}${jobDisplay} for you to review — nothing will be sent until you approve it.`,
    event: {
      type: 'open_email_draft',
      job_id: resolvedJobId,
      recipient_name: recipient_name ?? null,
      intent_hint: intent_hint ?? 'general',
    },
  }
}

async function handleEmailSyncStatus(builderId: string): Promise<Partial<ChatResponse>> {
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    const res = await fetch(`${appUrl}/api/email-sync/status?builder_id=${builderId}`)
    const data = await res.json() as {
      connected: boolean
      provider: 'gmail' | 'outlook' | null
      connected_at: string | null
      last_synced_at: string | null
      emails_processed_today: number
      jobs_matched_today: number
    }

    if (!data.connected) {
      return { message: 'Email sync is not connected. Go to Settings → Email sync to connect your Gmail or Outlook inbox.' }
    }

    const providerName = data.provider === 'gmail' ? 'Gmail' : 'Outlook'
    const connectedPhrase = data.connected_at ? ` Connected ${data.connected_at}.` : ''
    const syncPhrase = data.last_synced_at ? ` Last synced ${data.last_synced_at}.` : ''
    const todayPhrase =
      data.emails_processed_today > 0
        ? ` Today: ${data.emails_processed_today} email${data.emails_processed_today !== 1 ? 's' : ''} processed, ${data.jobs_matched_today} matched to jobs.`
        : ' No emails processed today yet.'

    return { message: `${providerName} is connected and monitoring your inbox.${connectedPhrase}${syncPhrase}${todayPhrase}` }
  } catch {
    return { message: 'Email sync isn\'t connected yet — go to **Settings → Email sync** to link your Gmail or Outlook inbox.' }
  }
}

async function handleSimulateEmail(builderId: string): Promise<Partial<ChatResponse>> {
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
      suggested_action: { type: string; description: string; draft?: { subject: string; body: string } } | null
    }

    if (!data.matched) {
      return { message: 'Simulated email received but could not be matched to any active job.' }
    }

    const address = data.job_address ?? 'an active job'
    const preview = 'Hi Dave, just checking on the invoice — can we pay via bank transfer?'

    return {
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
    return { message: 'Could not simulate email — the email sync endpoint is unavailable.' }
  }
}

async function handleMarginQuery(builderId: string): Promise<Partial<ChatResponse>> {
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (sbUrl && sbKey) {
    // Live path — fetch real quotes + variations from DB
    const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })

    // Get active/quoted jobs with their latest quotes
    const { data: quotes } = await sb
      .from('quotes')
      .select('id, job_id, total_cost, margin_pct, status, version')
      .eq('builder_id', builderId)
      .in('status', ['draft', 'pending_review', 'sent', 'approved'])
      .order('version', { ascending: false })

    if (!quotes || quotes.length === 0) {
      return { message: 'No quotes with margin data yet. Upload plans on a job to generate a quote.' }
    }

    // Keep only the latest quote per job
    const latestByJob = new Map<string, typeof quotes[0]>()
    for (const q of quotes as Array<{ id: string; job_id: string; total_cost: number | null; margin_pct: number | null; status: string; version: number }>) {
      if (!latestByJob.has(q.job_id)) latestByJob.set(q.job_id, q)
    }

    // Batch-fetch job details and approved variation totals in two parallel queries
    const jobIds = Array.from(latestByJob.keys())
    const [{ data: jobsData }, { data: allVars }] = await Promise.all([
      sb.from('jobs').select('id, address, status, job_ref').in('id', jobIds),
      sb.from('variations').select('job_id, amount').in('job_id', jobIds).eq('status', 'approved'),
    ])

    const jobMap = new Map(
      ((jobsData ?? []) as Array<{ id: string; address: string; status: string; job_ref: string | null }>)
        .map(j => [j.id, j])
    )
    const varsByJob = new Map<string, number>()
    for (const v of (allVars ?? []) as Array<{ job_id: string; amount: number | null }>) {
      varsByJob.set(v.job_id, (varsByJob.get(v.job_id) ?? 0) + (v.amount ?? 0))
    }

    const marginJobs: MarginJob[] = []
    for (const [jobId, quote] of Array.from(latestByJob.entries())) {
      if (!quote.total_cost) continue
      const j = jobMap.get(jobId)
      if (!j) continue

      const quotedMarginPct = quote.margin_pct ?? 18
      const quotedAmt = quote.total_cost
      const baseCost = quotedAmt * (1 - quotedMarginPct / 100)
      const variationImpact = varsByJob.get(jobId) ?? 0
      const projectedCost = baseCost + variationImpact
      const marginAmt = quotedAmt - projectedCost
      const marginPct = parseFloat(((marginAmt / quotedAmt) * 100).toFixed(1))

      marginJobs.push({
        id: j.id,
        job_ref: j.job_ref ?? '',
        address: j.address,
        status: j.status,
        quoted_amount: quotedAmt,
        projected_cost: projectedCost,
        margin_amount: marginAmt,
        margin_percent: marginPct,
        quoted_margin_percent: quotedMarginPct,
        cost_to_date: 0,
        variation_impact: variationImpact,
      })
    }

    if (marginJobs.length === 0) {
      return { message: 'No quoted jobs with margin data yet.' }
    }

    marginJobs.sort((a, b) => a.margin_percent - b.margin_percent)
    const bleeding = marginJobs.filter((j) => j.margin_percent < 10)
    const healthy = marginJobs.filter((j) => j.margin_percent >= 15)

    let message: string
    if (bleeding.length > 0) {
      const worst = bleeding[0]
      const isNeg = worst.margin_percent < 0
      const shortAddr = worst.address.split(',')[0]
      message = `The ${shortAddr} job is ${isNeg ? 'underwater' : 'at risk'} — margin tracking at ${isNeg ? '–' : ''}${Math.abs(worst.margin_percent).toFixed(1)}% against the quoted ${worst.quoted_margin_percent}%.`
      if (worst.variation_impact > 0) message += ` Approved variations have added $${worst.variation_impact.toLocaleString('en-AU')} to projected spend.`
      if (healthy.length > 0) message += ` ${healthy[0].address.split(',')[0]} is holding at ${healthy[0].margin_percent.toFixed(1)}%.`
    } else {
      message = `Margins looking ${healthy.length === marginJobs.length ? 'healthy' : 'acceptable'} across your ${marginJobs.length} job${marginJobs.length !== 1 ? 's' : ''}. Keep an eye on variations.`
    }

    return { message, margin_jobs: marginJobs }
  }

  // Demo fallback
  const activeJobs = DEMO_JOBS.filter(
    (j) => (j.status === 'active' || j.status === 'quoted') && j.quoted_amount !== undefined
  )
  if (activeJobs.length === 0) return { message: 'No active jobs with margin data right now.' }

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
    if (healthy.length > 0) message += ` The ${healthy[0].address.split(',')[0]} quote is holding at ${healthy[0].margin_percent.toFixed(1)}%.`
  } else {
    message = `Margins are looking ${healthy.length === marginJobs.length ? 'healthy' : 'acceptable'} across your ${marginJobs.length} job${marginJobs.length !== 1 ? 's' : ''}. Keep an eye on variations.`
  }

  return { message, margin_jobs: marginJobs }
}

// ─── Action orchestrator ──────────────────────────────────────────────────────
//
// Executes an ordered list of actions with shared context.
// Jobs resolved in one action (create_job) are available to subsequent actions
// (open_upload_panel, review_assumptions) via the context object.
// Events from all actions are accumulated and returned as events[].

async function orchestrateActions(
  actions: ExtractedAction[],
  ctx: OrchestrationContext,
  anthropic: Anthropic
): Promise<ChatResponse> {
  const events: ChatEvent[] = []
  const messageParts: string[] = []
  const stateChanges: StateChange[] = []
  let accumulated: Partial<ChatResponse> = {}
  const bulkJobsCreated: { address: string; client?: string }[] = []
  const bulkMode = actions.filter(a => a.type === 'create_job').length > 1

  for (const action of actions) {
    switch (action.type) {

      case 'morning_brief': {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
        const brief =
          supabaseUrl && serviceRoleKey
            ? await getLiveMorningBrief(ctx.builder_id, supabaseUrl, serviceRoleKey)
            : getDemoMorningBrief()
        messageParts.push(brief.message)
        accumulated.alerts = brief.alerts
        break
      }

      case 'add_worker': {
        const { name, role, email, phone } = action.entities
        if (!name || !role) {
          messageParts.push('Got it — who are you adding and what\'s their trade? For example: "add Sarah she\'s a plumber"')
          break
        }
        const result = await createWorker({ builder_id: ctx.builder_id, name, role, email, phone })
        accumulated.worker = result.worker
        accumulated.invite_url = result.invite_url
        messageParts.push(`Added ${name} as a ${result.worker.role.charAt(0).toUpperCase() + result.worker.role.slice(1)}. Invite link is ready — send it in two taps.`)
        events.push(result.modal_event)
        break
      }

      case 'create_job': {
        const { address, client_name, budget_hint, scope_notes, quote_deadline, client_deadline } = action.entities
        if (!address) {
          messageParts.push('Which address is this job at? For example: \'new job at 14 Smith St Fitzroy\'')
          break
        }

        // Detect vague address (no street number — just a suburb or area)
        const addressTrimmed = address.trim()
        const hasStreetNumber = /^\d|^lot\s|^unit\s|^flat\s/i.test(addressTrimmed)
        const isVague = !hasStreetNumber && addressTrimmed.split(/\s+/).length <= 3

        if (isVague && !ctx.force_create) {
          // Build an intake checklist showing exactly what's missing
          const missing: string[] = [
            `□ Exact street address — you mentioned "${addressTrimmed}" but I need a street number (e.g. 14 Smith St ${addressTrimmed})`,
          ]
          if (!client_name) missing.push('□ Client name and email — required to send the quote')
          missing.push('□ Plans — upload PDF via the Files tab once the job is created')
          stateChanges.push({ status: 'warning', label: `Address incomplete — street number needed` })
          messageParts.push(
            `To get this job started I need a few more details:\n\n${missing.join('\n')}\n\n` +
            `Reply with the full address and I'll create the job immediately. Example:\n"New job at 14 Smith St ${addressTrimmed} for ${client_name ?? 'the client'}"`
          )
          break
        }

        const result = await createJob({
          builder_id: ctx.builder_id,
          address,
          client_name,
          budget_hint,
          scope_notes,
          force_create: ctx.force_create,
        })

        // Update shared context so subsequent actions know which job to use
        ctx.resolved_job_id = result.job.id
        ctx.resolved_job = result.job
        ctx.is_duplicate = result.is_duplicate

        const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
        const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

        if (result.is_duplicate && result.existing_job) {
          accumulated.duplicate = true
          accumulated.existing_job = result.existing_job
          accumulated.job = result.existing_job
          stateChanges.push({ status: 'found', label: `Existing job found at ${result.existing_job.address} (${result.existing_job.status})` })
          events.push({ type: 'show_duplicate_warning', job_id: result.existing_job.id })

          // Write extracted context back to the existing job — only update null fields
          if ((client_name || budget_hint || scope_notes || quote_deadline || client_deadline) && sbUrl && sbKey) {
            const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
            const { data: existingRow } = await sb
              .from('jobs').select('budget_estimate, scope_notes, notes, quote_deadline, client_deadline').eq('id', result.existing_job.id).single()
            if (existingRow) {
              const updates: Record<string, unknown> = {}
              if (budget_hint && !existingRow.budget_estimate) {
                updates.budget_estimate = parseFloat(budget_hint.replace(/,/g, ''))
                stateChanges.push({ status: 'saved', label: `Budget saved ($${parseInt(budget_hint).toLocaleString('en-AU')})` })
              } else if (budget_hint) {
                stateChanges.push({ status: 'info', label: `Budget already set — not overwritten` })
              }
              if (scope_notes && !existingRow.scope_notes) {
                updates.scope_notes = scope_notes
                stateChanges.push({ status: 'saved', label: 'Scope notes updated' })
              }
              if (client_name && !existingRow.notes) {
                updates.notes = `Client: ${client_name}`
                stateChanges.push({ status: 'saved', label: `Client linked (${client_name})` })
              }
              if (quote_deadline && !existingRow.quote_deadline) {
                updates.quote_deadline = quote_deadline
                stateChanges.push({ status: 'saved', label: `Quote deadline set (${quote_deadline})` })
              }
              if (client_deadline && !existingRow.client_deadline) {
                updates.client_deadline = client_deadline
                stateChanges.push({ status: 'saved', label: `Client deadline noted (${client_deadline})` })
              }
              if (Object.keys(updates).length > 0) {
                await sb.from('jobs').update(updates).eq('id', result.existing_job.id)
              }
            }
          }

          if (!bulkMode) {
            messageParts.push(`You already have a job at ${result.existing_job.address} (currently ${result.existing_job.status}). Opening that job now.`)
          } else {
            bulkJobsCreated.push({ address: result.existing_job.address, client: client_name })
          }

        } else {
          accumulated.job = result.job
          stateChanges.push({ status: 'saved', label: `New job created at ${result.job.address}` })
          if (client_name) stateChanges.push({ status: 'saved', label: `Client linked (${client_name})` })
          if (budget_hint) stateChanges.push({ status: 'saved', label: `Budget saved ($${parseInt(budget_hint).toLocaleString('en-AU')})` })
          if (scope_notes) stateChanges.push({ status: 'saved', label: 'Scope notes saved' })

          // Persist deadline on the new job
          if ((quote_deadline || client_deadline) && sbUrl && sbKey) {
            const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
            const dlUpdates: Record<string, unknown> = {}
            if (quote_deadline) { dlUpdates.quote_deadline = quote_deadline; stateChanges.push({ status: 'saved', label: `Quote deadline set (${quote_deadline})` }) }
            if (client_deadline) { dlUpdates.client_deadline = client_deadline; stateChanges.push({ status: 'saved', label: `Client deadline noted (${client_deadline})` }) }
            await sb.from('jobs').update(dlUpdates).eq('id', result.job.id)
          }

          if (bulkMode) {
            // Collect for summary message; don't open a panel for each
            bulkJobsCreated.push({ address: result.job.address, client: client_name })
          } else {
            const budgetStr = budget_hint ? ` Budget noted: ~$${parseInt(budget_hint).toLocaleString('en-AU')}.` : ''
            const clientStr = client_name ? ` Client: ${client_name}.` : ''
            messageParts.push(`New job at ${result.job.address} created.${clientStr}${budgetStr} Upload your plans to start the quote.`)
            events.push({ type: 'open_upload_panel', job_id: result.job.id })
          }
        }
        break
      }

      case 'open_upload_panel': {
        // Only emit if we have a resolved job and haven't already emitted an upload panel event
        // (create_job already emits one for new jobs)
        const jobId = ctx.resolved_job_id
        if (jobId && !events.some((e) => e.type === 'open_upload_panel')) {
          events.push({ type: 'open_upload_panel', job_id: jobId })
        } else if (!jobId) {
          messageParts.push(
            'To upload plans: open a job from the panel on the right, tap the **Files** tab, and use the upload button. WorkA reads the PDF, extracts quantities automatically, and flags any assumptions for you to review before the quote goes out.\n\n' +
            'Which job are you uploading plans for? I can open it for you.'
          )
        }
        break
      }

      case 'review_assumptions': {
        const jobId = ctx.resolved_job_id
        const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
        const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

        if (jobId && sbUrl && sbKey) {
          const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })

          // Step 1: Verify files actually exist (don't trust the builder's statement)
          const { data: uploadedFiles } = await sb
            .from('files')
            .select('id, filename, intake_status')
            .eq('job_id', jobId)
            .order('created_at', { ascending: false })

          if (!uploadedFiles || uploadedFiles.length === 0) {
            stateChanges.push({ status: 'warning', label: 'No plans found in database' })
            messageParts.push("I can't find any uploaded plans for this job. Use the upload button to add them, then I'll extract quantities and flag every assumption.")
            break
          }

          const processing = uploadedFiles.filter((f: { intake_status: string }) => f.intake_status === 'processing')
          const uploaded = uploadedFiles.filter((f: { intake_status: string }) => f.intake_status === 'uploaded')
          const extracted = uploadedFiles.filter((f: { intake_status: string }) => f.intake_status === 'extracted')
          const failed = uploadedFiles.filter((f: { intake_status: string }) => f.intake_status === 'failed')

          stateChanges.push({ status: 'found', label: `${uploadedFiles.length} plan${uploadedFiles.length > 1 ? 's' : ''} found` })

          if (processing.length > 0) {
            stateChanges.push({ status: 'info', label: `${processing.length} plan${processing.length > 1 ? 's' : ''} currently processing` })
            messageParts.push(`Plans found and processing now — I'll flag assumptions as soon as extraction completes.`)
            break
          }

          if (uploaded.length > 0 && extracted.length === 0) {
            stateChanges.push({ status: 'warning', label: 'Plans uploaded but intake has not started' })
            messageParts.push(`Plans uploaded but not yet processed. The intake pipeline hasn't run — this usually starts automatically after upload. Try re-uploading if it's been more than a few minutes.`)
            break
          }

          if (failed.length > 0 && extracted.length === 0) {
            stateChanges.push({ status: 'blocked', label: `${failed.length} plan${failed.length > 1 ? 's' : ''} failed to process` })
            messageParts.push(`Plan processing failed. Try re-uploading the file — if the problem persists, check that the PDF is not encrypted or corrupted.`)
            break
          }

          // Step 2: Check for a draft quote
          const { data: quoteRow } = await sb
            .from('quotes')
            .select('id, status')
            .eq('job_id', jobId)
            .in('status', ['draft', 'pending_review'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (quoteRow) {
            stateChanges.push({ status: 'found', label: 'Draft quote exists' })
            const { data: items } = await sb
              .from('quote_line_items')
              .select('description, confidence')
              .eq('quote_id', quoteRow.id)
              .eq('is_assumption', true)
              .eq('assumption_status', 'unresolved')

            if (items && items.length > 0) {
              stateChanges.push({ status: 'blocked', label: `${items.length} assumption${items.length === 1 ? '' : 's'} blocking quote` })
              const list = items.map((i: { description: string }) => `• ${i.description}`).join('\n')
              messageParts.push(`${items.length} assumption${items.length === 1 ? '' : 's'} need your input before the quote can be sent:\n${list}`)
            } else {
              stateChanges.push({ status: 'info', label: 'No unresolved assumptions — quote ready' })
              messageParts.push('No unresolved assumptions — quote is clear to send once you\'re happy with the numbers.')
            }
          } else {
            stateChanges.push({ status: 'warning', label: 'No draft quote yet — plans may still be processing' })
            messageParts.push("Plans found but no draft quote yet. Once extraction completes, I'll flag every assumption that needs your input.")
          }
        } else {
          // Demo mode — surface demo assumptions regardless of jobId
          const unresolved = DEMO_ASSUMPTIONS.filter(a => a.resolution_type === 'unresolved')
          if (unresolved.length > 0) {
            const list = unresolved.map(a => `• ${a.description} (${a.trade_category})`).join('\n')
            stateChanges.push({ status: 'blocked', label: `${unresolved.length} assumption${unresolved.length === 1 ? '' : 's'} blocking quote` })
            messageParts.push(`${unresolved.length} assumptions need your input before the quote can be issued:\n\n${list}\n\nClick "Review assumptions" to work through them one by one.`)
          } else {
            messageParts.push('No unresolved assumptions — quote is ready to advance.')
          }
        }
        break
      }

      case 'job_query': {
        const result = await handleJobQuery(action.entities, ctx.builder_id)
        if (result.message) messageParts.push(result.message)
        if (result.event) events.push(result.event)
        if (result.job_list) accumulated.job_list = result.job_list
        break
      }

      case 'variation': {
        const result = await handleVariationIntent(action.entities, ctx.builder_id)
        if (result.message) messageParts.push(result.message)
        if (result.event) events.push(result.event)
        if (result.variation) accumulated.variation = result.variation
        if (result.all_variations) accumulated.all_variations = result.all_variations
        break
      }

      case 'invoice': {
        const result = await handleInvoice(ctx.builder_id)
        if (result.message) messageParts.push(result.message)
        if (result.event) events.push(result.event)
        break
      }

      case 'email_draft': {
        const result = handleEmailDraft(action.entities)
        if (result.message) messageParts.push(result.message)
        if (result.event) events.push(result.event)
        break
      }

      case 'email_sync_status': {
        const result = await handleEmailSyncStatus(ctx.builder_id)
        if (result.message) messageParts.push(result.message)
        break
      }

      case 'simulate_email': {
        const result = await handleSimulateEmail(ctx.builder_id)
        if (result.message) messageParts.push(result.message)
        if (result.event) events.push(result.event)
        break
      }

      case 'margin_query': {
        const result = await handleMarginQuery(ctx.builder_id)
        if (result.message) messageParts.push(result.message)
        if (result.margin_jobs) accumulated.margin_jobs = result.margin_jobs
        break
      }

      case 'update_job_context': {
        // Builder mentioned new context about an existing job mid-conversation.
        // Only update fields that are currently null to avoid overwriting deliberate data.
        const jobId = ctx.resolved_job_id
        const { scope_notes: newScope, budget_hint: newBudget, client_name: newClient } = action.entities
        const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
        const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

        if (jobId && sbUrl && sbKey && (newScope || newBudget || newClient)) {
          const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
          const { data: existingRow } = await sb
            .from('jobs').select('budget_estimate, scope_notes, notes').eq('id', jobId).single()
          if (existingRow) {
            const updates: Record<string, unknown> = {}
            if (newBudget && !existingRow.budget_estimate) {
              updates.budget_estimate = parseFloat(newBudget.replace(/,/g, ''))
            }
            if (newScope && !existingRow.scope_notes) {
              updates.scope_notes = newScope
            }
            if (newClient && !existingRow.notes) {
              updates.notes = `Client: ${newClient}`
            }
            if (Object.keys(updates).length > 0) {
              await sb.from('jobs').update(updates).eq('id', jobId)
              messageParts.push('Got it — noted on the job.')
            }
          }
        }
        break
      }

      case 'add_task': {
        const { description, job_address, assignee_name } = action.entities as {
          description?: string
          job_address?: string
          assignee_name?: string
        }

        // If no specific task was extracted, ask for it — don't log a vague entry
        const isVagueTask = !description || description.length > 120 || description === 'task'
        if (isVagueTask) {
          messageParts.push(
            `What's the specific task? Tell me like:\n\n` +
            `• "Add task at Brunswick: install footings — assign to Jack"\n` +
            `• "Schedule Mick to check plumbing at Fitzroy tomorrow"\n\n` +
            `Full task scheduling with due dates and worker notifications is coming — for now I'll log it to the job.`
          )
          break
        }

        const jobRef = job_address ?? ctx.resolved_job?.address ?? 'the job'
        const assignLine = assignee_name ? ` for ${assignee_name}` : ' for your crew'
        stateChanges.push({ status: 'info', label: `Task logged: ${description}` })
        messageParts.push(
          `Task noted${assignLine} at ${jobRef}: "${description}".\n\n` +
          `Full task scheduling — due dates, status tracking, and worker notifications — is coming. Your crew can see assigned tasks in the worker portal at /worker.`
        )
        break
      }

      case 'upload_rates': {
        messageParts.push(
          `Two ways to load your pricing into WorkA:\n\n` +
          `**1. Past quotes or plans (PDF)** — upload through the Files tab on any job. WorkA extracts quantities and rates automatically and stores them as your learned rates.\n\n` +
          `**2. Supplier price sheets (CSV)** — coming in the next release. Prepare a spreadsheet with columns: trade_category, description, unit, rate_ex_gst.\n\n` +
          `Either way, once your rates are in, WorkA uses them first for every future quote — no more guessing.`
        )
        break
      }

      case 'client_lookup': {
        const { client_name } = action.entities
        if (!client_name) {
          messageParts.push('Which client are you asking about? Give me their name and I\'ll check your job history.')
          break
        }
        const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
        const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY
        if (sbUrl && sbKey) {
          const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
          const { data: clients } = await sb
            .from('clients')
            .select('id, name')
            .eq('builder_id', ctx.builder_id)
            .ilike('name', `%${client_name}%`)
          if (!clients || clients.length === 0) {
            messageParts.push(`No client named "${client_name}" on record — this would be a new client. They'll be added when you create a job for them.`)
          } else {
            const typedClients = clients as Array<{ id: string; name: string }>
            for (const client of typedClients) {
              const { data: jobs } = await sb
                .from('jobs')
                .select('address, status, created_at')
                .eq('builder_id', ctx.builder_id)
                .eq('client_id', client.id)
                .order('created_at', { ascending: false })
              const typedJobs = (jobs ?? []) as Array<{ address: string; status: string; created_at: string }>
              if (typedJobs.length === 0) {
                messageParts.push(`${client.name} is in your client list but has no jobs yet.`)
              } else {
                const jobLines = typedJobs.map(j => `• ${j.address} — ${j.status} (started ${relativeDate(j.created_at)})`).join('\n')
                messageParts.push(`${client.name} — ${typedJobs.length} job${typedJobs.length === 1 ? '' : 's'} on record:\n${jobLines}`)
                stateChanges.push({ status: 'found', label: `${typedJobs.length} job${typedJobs.length === 1 ? '' : 's'} found for ${client.name}` })
              }
            }
          }
        } else {
          // Demo mode
          const ref = client_name.toLowerCase()
          const DEMO_CLIENT_MAP: Array<{ keywords: string[]; name: string; jobs: string[] }> = [
            { keywords: ['henderson', 'hendersons'], name: 'The Hendersons', jobs: ['14 Merri St, Fitzroy — active (started 45 days ago)'] },
            { keywords: ['caruso', 'tom caruso', 'tom'], name: 'Tom Caruso', jobs: ['8 Burnside Rd, Toorak — quoted (started 12 days ago)'] },
          ]
          const match = DEMO_CLIENT_MAP.find(c => c.keywords.some(kw => ref.includes(kw) || kw.includes(ref.split(' ')[0])))
          if (match) {
            const lines = match.jobs.map(j => `• ${j}`).join('\n')
            messageParts.push(`${match.name} — ${match.jobs.length} job${match.jobs.length === 1 ? '' : 's'} on record:\n${lines}`)
            stateChanges.push({ status: 'found', label: `Job history found for ${match.name}` })
          } else {
            messageParts.push(`No record of working with "${client_name}" before. This would be a new client.`)
          }
        }
        break
      }

      case 'meeting_prep': {
        const { client_name, job_address } = action.entities
        const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
        const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY
        if (sbUrl && sbKey) {
          const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
          let jobId: string | null = null
          let jobAddr = ''
          let jobStatus = ''
          // Find job by address or client name
          if (job_address) {
            const { data: j } = await sb.from('jobs').select('id, address, status, budget_estimate, scope_notes').eq('builder_id', ctx.builder_id).ilike('address', `%${job_address}%`).not('status', 'eq', 'archived').limit(1).maybeSingle()
            if (j) { jobId = (j as { id: string; address: string; status: string }).id; jobAddr = (j as { address: string }).address; jobStatus = (j as { status: string }).status }
          } else if (client_name) {
            const { data: cls } = await sb.from('clients').select('id').eq('builder_id', ctx.builder_id).ilike('name', `%${client_name}%`).limit(1)
            if (cls && cls.length > 0) {
              const { data: j } = await sb.from('jobs').select('id, address, status, budget_estimate, scope_notes').eq('builder_id', ctx.builder_id).eq('client_id', (cls[0] as { id: string }).id).not('status', 'eq', 'archived').order('created_at', { ascending: false }).limit(1).maybeSingle()
              if (j) { jobId = (j as { id: string; address: string; status: string }).id; jobAddr = (j as { address: string }).address; jobStatus = (j as { status: string }).status }
            }
          }
          if (!jobId) {
            messageParts.push(`No job found for ${client_name ?? job_address ?? 'that client'}. Your active jobs:\n` + (await (async () => { const { data: js } = await sb.from('jobs').select('address, status').eq('builder_id', ctx.builder_id).not('status', 'eq', 'archived').limit(5); return (js ?? []).map((j: { address: string; status: string }) => `• ${j.address} — ${j.status}`).join('\n') })()))
            break
          }
          const [{ data: quotes }, { data: variations }, { data: invoices }, { data: comms }] = await Promise.all([
            sb.from('quotes').select('status, total_cost, version, confidence_score, sent_at').eq('job_id', jobId).order('version', { ascending: false }).limit(1),
            sb.from('variations').select('title, amount, status').eq('job_id', jobId),
            sb.from('invoices').select('amount, status').eq('job_id', jobId),
            sb.from('communication_history').select('channel, subject, timestamp').eq('job_id', jobId).order('timestamp', { ascending: false }).limit(3),
          ])
          const quote = quotes?.[0] as { status: string; total_cost: number | null; version: number; confidence_score: number | null; sent_at: string | null } | null
          const pendingVars = ((variations ?? []) as Array<{ title: string; amount: number | null; status: string }>).filter(v => v.status === 'pending')
          const overdueInvs = ((invoices ?? []) as Array<{ amount: number; status: string }>).filter(i => i.status === 'overdue' || i.status === 'sent')
          const lines: string[] = [`**${client_name ?? jobAddr} — ${jobAddr} (${jobStatus})**`]
          if (quote) { lines.push(`Quote: $${(quote.total_cost ?? 0).toLocaleString('en-AU')} — ${quote.status} (v${quote.version}, ${quote.confidence_score}% confidence)`) }
          else { lines.push('Quote: Not started yet') }
          if (pendingVars.length > 0) { lines.push(`Pending variations: ${pendingVars.length} — $${pendingVars.reduce((s, v) => s + (v.amount ?? 0), 0).toLocaleString('en-AU')} waiting on approval`) }
          if (overdueInvs.length > 0) { lines.push(`Outstanding invoices: $${overdueInvs.reduce((s, i) => s + i.amount, 0).toLocaleString('en-AU')}`) }
          if ((comms ?? []).length > 0) { const c = (comms as Array<{ channel: string; subject: string | null; timestamp: string }>)[0]; lines.push(`Last contact: ${c.channel} ${relativeDate(c.timestamp)} — ${c.subject ?? 'no subject'}`) }
          lines.push(''); lines.push('Key questions to raise:')
          if (!quote) lines.push('• When do they need the quote by?')
          if (pendingVars.length > 0) lines.push('• Confirm sign-off on pending variations')
          if (overdueInvs.length > 0) lines.push('• Discuss outstanding payment')
          messageParts.push(lines.join('\n'))
          events.push({ type: 'open_job_snapshot', job_id: jobId, job_address: jobAddr, job_status: jobStatus })
        } else {
          // Demo mode
          const ref = (client_name ?? job_address ?? '').toLowerCase()
          const DEMO_CLIENT_BRIEFINGS: Array<{ keywords: string[]; brief: string; job_id: string; job_address: string; job_status: string }> = [
            {
              keywords: ['henderson', 'hendersons', 'fitzroy', 'merri'],
              job_id: '00000000-0000-0000-0000-000000000010',
              job_address: '14 Merri St, Fitzroy',
              job_status: 'active',
              brief: [
                '**The Hendersons — 14 Merri St, Fitzroy (active)**',
                'Quote: $142,000 approved — job active',
                'Pending variations: 2 — $3,880 total waiting on approval',
                'OVERDUE invoice: $28,000 — sent 7 days ago, no payment',
                'Last contact: email 7 days ago — invoice sent',
                '',
                'Key questions to raise:',
                '• When will they pay the $28,000 invoice?',
                '• Get written approval on the 2 pending variations ($3,880)',
                '• Confirm scope is still as agreed — no further changes',
              ].join('\n'),
            },
            {
              keywords: ['caruso', 'tom', 'toorak', 'burnside'],
              job_id: '00000000-0000-0000-0000-000000000020',
              job_address: '8 Burnside Rd, Toorak',
              job_status: 'quoted',
              brief: [
                '**Tom Caruso — 8 Burnside Rd, Toorak (quoted)**',
                'Quote: $127,500 sent 5 days ago — awaiting approval',
                'No variations, no invoices yet',
                'Last contact: email 5 days ago — quote sent',
                '',
                'Key questions to raise:',
                '• Has he reviewed the quote? Any questions?',
                '• Confirm he\'s ready to proceed — get verbal approval today',
                '• Start date — when does he want work to begin?',
              ].join('\n'),
            },
          ]
          const match = DEMO_CLIENT_BRIEFINGS.find(b => b.keywords.some(kw => ref.includes(kw)))
          if (match) {
            messageParts.push(match.brief)
            events.push({ type: 'open_job_snapshot', job_id: match.job_id, job_address: match.job_address, job_status: match.job_status })
          } else {
            messageParts.push(
              `No job found for "${client_name ?? job_address ?? 'that client'}". Your active jobs:\n` +
              '• 14 Merri St, Fitzroy — Hendersons (active)\n' +
              '• 8 Burnside Rd, Toorak — Tom Caruso (quoted)\n' +
              '• 52 Bendigo St, Brunswick — quoting\n\n' +
              'If this is a new client, type "new job at [address]" to get started.'
            )
          }
        }
        break
      }

      case 'payment_risk': {
        const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
        const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY
        if (sbUrl && sbKey) {
          const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
          const riskLines: string[] = []

          // Fetch all three categories in parallel
          const [{ data: invs }, { data: sentQuotes }, { data: draftQs }] = await Promise.all([
            sb.from('invoices').select('job_id, amount, status').eq('builder_id', ctx.builder_id).in('status', ['sent', 'overdue']),
            sb.from('quotes').select('job_id, total_cost, sent_at').eq('builder_id', ctx.builder_id).eq('status', 'sent'),
            sb.from('quotes').select('id, job_id').eq('builder_id', ctx.builder_id).in('status', ['draft', 'pending_review']),
          ])

          const invList = (invs ?? []) as Array<{ job_id: string; amount: number; status: string }>
          const sentList = (sentQuotes ?? []) as Array<{ job_id: string; total_cost: number | null; sent_at: string | null }>
          const draftList = (draftQs ?? []) as Array<{ id: string; job_id: string }>

          // Batch-fetch all job addresses and assumption counts in parallel
          const allJobIds = Array.from(new Set([...invList.map(i => i.job_id), ...sentList.map(q => q.job_id), ...draftList.map(q => q.job_id)]))
          const draftQIds = draftList.map(q => q.id)

          const [{ data: allJobs }, { data: assumptionRows }] = await Promise.all([
            allJobIds.length > 0 ? sb.from('jobs').select('id, address').in('id', allJobIds) : Promise.resolve({ data: [] as Array<{ id: string; address: string }> }),
            draftQIds.length > 0 ? sb.from('quote_line_items').select('quote_id').in('quote_id', draftQIds).eq('is_assumption', true).eq('assumption_status', 'unresolved') : Promise.resolve({ data: [] as Array<{ quote_id: string }> }),
          ])

          const jobAddrMap = new Map(((allJobs ?? []) as Array<{ id: string; address: string }>).map(j => [j.id, j.address]))
          const assumptionsByQuote = new Map<string, number>()
          for (const row of (assumptionRows ?? []) as Array<{ quote_id: string }>) {
            assumptionsByQuote.set(row.quote_id, (assumptionsByQuote.get(row.quote_id) ?? 0) + 1)
          }

          for (const inv of invList) {
            const addr = jobAddrMap.get(inv.job_id) ?? 'unknown job'
            riskLines.push(`• ${inv.status === 'overdue' ? '🔴' : '🟡'} ${addr}: $${inv.amount.toLocaleString('en-AU')} invoice ${inv.status === 'overdue' ? 'overdue' : 'outstanding — not yet paid'}`)
          }
          for (const q of sentList) {
            const addr = jobAddrMap.get(q.job_id) ?? 'unknown job'
            const days = q.sent_at ? Math.floor((Date.now() - new Date(q.sent_at).getTime()) / 86400000) : null
            riskLines.push(`• 🟡 ${addr}: $${(q.total_cost ?? 0).toLocaleString('en-AU')} quote waiting${days ? ` ${days} days` : ''} — no client approval yet, can't invoice`)
          }
          for (const q of draftList) {
            const count = assumptionsByQuote.get(q.id) ?? 0
            if (count > 0) {
              const addr = jobAddrMap.get(q.job_id) ?? 'unknown job'
              riskLines.push(`• 🔴 ${addr}: ${count} unresolved assumption${count === 1 ? '' : 's'} blocking quote — can't issue until cleared`)
            }
          }

          if (riskLines.length === 0) {
            messageParts.push('No significant payment risks right now. Invoices are current, quotes are progressing cleanly.')
          } else {
            messageParts.push(
              `${riskLines.length} thing${riskLines.length === 1 ? '' : 's'} put${riskLines.length === 1 ? 's' : ''} payment at risk in the next 30 days:\n\n` +
              riskLines.join('\n') +
              '\n\nPriority: clear blocked quotes first — you can\'t invoice a job until the client has approved.'
            )
          }
        } else {
          // Demo mode
          messageParts.push(
            '3 things put payment at risk over the next 30 days:\n\n' +
            '🔴 Fitzroy — $28,000 invoice overdue 3 days. The Hendersons haven\'t paid. Every day without contact increases write-off risk.\n\n' +
            '🟡 Toorak — $127,500 quote sent to Tom Caruso 5 days ago, no approval. No approval = no contract = invoicing can\'t start.\n\n' +
            '🔴 Brunswick — 2 assumptions unresolved, blocking quote issue. Can\'t invoice a job that hasn\'t been quoted.\n\n' +
            'Recommended: (1) Resolve Brunswick assumptions now — takes 5 minutes. (2) Call the Hendersons today. (3) Follow up Caruso by email.'
          )
        }
        break
      }

      case 'conflict_detected': {
        const { statement_a, statement_b, entity_type } = action.entities
        const entityLabel = entity_type ? ` on this ${entity_type}` : ''
        stateChanges.push({ status: 'warning', label: 'Conflicting instructions — no changes made' })
        messageParts.push(
          `Potential conflict detected${entityLabel} — I haven't made any changes.\n\n` +
          (statement_a ? `Statement 1: "${statement_a}"\n` : '') +
          (statement_b ? `Statement 2: "${statement_b}"\n` : '') +
          `\nWhich is correct? Reply with the definitive status and I'll update it.`
        )
        break
      }

      case 'worker_onboarding': {
        const { name, start_date, job_address } = action.entities
        const workerLabel = name ?? 'your new worker'
        const startLabel = start_date ? ` (starting ${start_date})` : ''
        const jobLabel = job_address ? ` on ${job_address}` : ''

        const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
        const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY
        let profileStatus = ''

        if (name && sbUrl && sbKey) {
          const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
          const { data: existing } = await sb
            .from('workers')
            .select('name, status, invite_token')
            .eq('builder_id', ctx.builder_id)
            .ilike('name', `%${name}%`)
            .limit(1)
            .maybeSingle()
          if (existing) {
            const w = existing as { name: string; status: string; invite_token: string | null }
            profileStatus = w.status === 'active'
              ? `✓ ${w.name} is already active in WorkA.`
              : w.invite_token
                ? `✓ ${w.name} has been invited — link not yet accepted.`
                : `⚠ ${w.name} has a profile but no invite sent yet.`
          } else {
            profileStatus = `⚠ No profile found for ${name} — type "add ${name}, they're a [trade]" to create one and send an invite.`
          }
        } else if (name) {
          profileStatus = `Type "add ${name}, they're a [trade]" to create a profile and send their invite link.`
        }

        messageParts.push(
          `Here's what ${workerLabel} needs before starting on site${jobLabel}${startLabel}:\n\n` +
          (profileStatus ? `${profileStatus}\n\n` : '') +
          `Site checklist:\n` +
          `□ WorkA profile created and invite accepted\n` +
          `□ Trade licence confirmed on file (required for licensed trades)\n` +
          `□ Site induction completed\n` +
          `□ Emergency contact recorded\n` +
          `□ Assigned to the correct job in WorkA\n\n` +
          `Licences and inductions need to be recorded outside WorkA for now — job assignment and invites are handled here.`
        )
        break
      }

      case 'roadmap': {
        messageParts.push(
          `Here's what's coming to WorkA:\n\n` +
          `**Already live:**\n` +
          `• Morning brief — daily alerts ranked by urgency\n` +
          `• Job creation, quoting, and plan intake via PDF upload\n` +
          `• Variation logging and client approval flow\n` +
          `• Invoice creation and overdue tracking\n` +
          `• Email drafting and communication history\n` +
          `• Worker invites and mobile worker portal\n` +
          `• Margin analysis across active jobs\n` +
          `• Client meeting prep and payment risk analysis\n\n` +
          `**Coming next:**\n` +
          `• Full task scheduling — assign tasks to workers with due dates and notifications\n` +
          `• Team notifications and in-app worker messaging\n` +
          `• CSV rate sheet import from suppliers\n` +
          `• Xero sync — push invoices directly to your accounting software\n` +
          `• SWMS generation — auto-draft Safe Work Method Statements from job scope\n` +
          `• Site diary and weather-delay logging\n` +
          `• Client portal — let clients view quote status and approve variations online\n\n` +
          `Anything specific you want prioritised? Reply and I'll note it.`
        )
        break
      }

      case 'team_notifications': {
        messageParts.push(
          `Team messaging and notifications are on the roadmap — here's where things stand:\n\n` +
          `**What exists now:**\n` +
          `• Workers can log into the worker portal (/worker) to see their assigned job for the day\n` +
          `• You can invite crew via WorkA — they get an SMS/email link\n` +
          `• Communication history is tracked per job in the Comms tab\n\n` +
          `**What's coming:**\n` +
          `• In-app task notifications pushed to workers' phones when you assign them a task\n` +
          `• Builder dashboard alerts when workers check in or complete tasks\n` +
          `• Group messaging per job site\n\n` +
          `For now, use the worker portal (/worker) for site updates and email/SMS via the Comms tab for client comms.`
        )
        break
      }

      case 'unknown':
      default: {
        if (actions.length === 1) {
          messageParts.push('I\'m not sure what you mean. Try typing "whats on today" to see your morning brief, or ask me about a job.')
        }
        break
      }
    }
  }

  // Emit bulk job creation summary (suppressed per-job messages above)
  if (bulkJobsCreated.length > 0) {
    const jobList = bulkJobsCreated.map(j => `• ${j.address}${j.client ? ` — ${j.client}` : ''}`).join('\n')
    messageParts.push(
      `${bulkJobsCreated.length} job${bulkJobsCreated.length === 1 ? '' : 's'} created:\n${jobList}\n\n` +
      `Open each job from the panel on the right and upload plans via the Files tab to start quoting.`
    )
    stateChanges.push({ status: 'saved', label: `${bulkJobsCreated.length} jobs created` })
  }

  // If nothing produced a message (shouldn't happen, but be safe)
  if (messageParts.length === 0) {
    messageParts.push('I\'m not sure what you mean. Try typing "whats on today" to see your morning brief, or ask me about a job.')
  }

  // Suppress unused var
  void anthropic

  return {
    intent: actions.map((a) => a.type).join('+'),
    message: messageParts.join('\n\n'),
    events: events.length > 0 ? events : undefined,
    event: events.length > 0 ? events[0] : undefined,
    state_changes: stateChanges.length > 0 ? stateChanges : undefined,
    ...accumulated,
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
- "meeting with [client]" — get a pre-meeting briefing on a client/job
- "what's most likely to stop me getting paid" — payment risk analysis
- "have we worked with [client] before" — client history lookup
- "remind Jack to install footings at Brunswick" or "add task at Brunswick: install footings" — log a task for your crew

Worker management: removing/deactivating a worker is not yet available via chat — direct the builder to Settings → Team. Workers can be set to inactive status there.

Upload & memory notes:
- Uploading plans: use the upload button inside any job panel — WorkA extracts quantities and flags assumptions
- Uploading past quotes or pricing: currently the builder can upload PDFs through a job's Files tab; CSV rate sheet import is coming. WorkA learns rates automatically from approved quotes.

What WorkA does NOT have yet (but is coming):
- Xero sync
- SWMS (Safe Work Method Statements) generation
- Full task scheduling with worker notifications
- CSV rate sheet import from suppliers
- Team group chat
- Client portal

Rules: never invent data you don't have. Keep responses under 4 sentences unless listing items. All amounts in AUD. If asked what WorkA can't do or what's coming, be honest about the roadmap items above.`

  const fallbackMsg = 'I\'m not sure what you mean. Try typing "whats on today" to see your morning brief, or ask me about a job.'
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
      message: text ?? fallbackMsg,
    }
  } catch {
    return { intent: 'unknown', message: fallbackMsg }
  }
}

// ─── Demo mode keyword router ─────────────────────────────────────────────────
//
// Mirrors the multi-action logic without an API key.
// Builds an action list from keyword detection then calls orchestrateActions
// with a null anthropic reference (no AI calls needed in demo mode).

// Derived from DEMO_JOBS — single source of truth for demo job data
const DEMO_JOB_LIST: JobListItem[] = DEMO_JOBS.map(j => ({
  id: j.id,
  address: j.address,
  status: j.status,
  client_name: j.client_name !== 'Brunswick client' ? j.client_name : undefined,
  job_ref: j.job_ref,
}))

async function routeDemoMessage(
  message: string,
  builderId: string,
  forceCreate: boolean
): Promise<ChatResponse> {
  const lower = message.toLowerCase()

  // Fast-path: job list — return structured data directly so tapping opens the panel
  const isJobListQuery =
    lower === 'show my jobs' || lower === 'my jobs' || lower === 'list jobs' ||
    lower.includes('show my jobs') || lower.includes('list my jobs') ||
    lower.includes('lost my jobs') || lower.includes('where are my jobs') ||
    (lower.includes('show') && lower.includes('job') && !lower.includes('quote') && !lower.includes('invoice')) ||
    (lower.includes('list') && lower.includes('job') && !lower.includes('quote'))
  if (isJobListQuery) {
    return {
      intent: 'job_query',
      message: 'You have 3 active jobs. Tap one to open it.',
      job_list: DEMO_JOB_LIST,
    }
  }

  const actions: ExtractedAction[] = []

  // Morning brief
  if (
    lower.includes('today') ||
    lower.includes('brief') ||
    lower.includes('morning') ||
    lower.match(/^what('?s| is) on/)
  ) {
    actions.push({ type: 'morning_brief', entities: {}, confidence: 90 })
  }

  // Bulk job creation — "I've got 3 jobs: 14 Smith St (Henderson), 8 Brown Rd (Caruso), 22 Jones Ave"
  const bulkJobListMatch = lower.match(/(?:have|got|running|working on|managing|juggling)\s+(?:\d+\s+)?(?:jobs?|projects?|sites?)[:\s,]+(.+)/i)
  if (bulkJobListMatch && !actions.some(a => a.type === 'create_job')) {
    const rawList = bulkJobListMatch[1]
    // Split on commas that are followed by a digit or uppercase (likely address boundary)
    const entries = rawList.split(/,\s*(?=\d|\b[A-Z])/).map(s => s.trim()).filter(Boolean)
    if (entries.length > 1) {
      for (const entry of entries) {
        const clientMatch = entry.match(/\(([^)]+)\)/)
        const address = entry.replace(/\([^)]+\)/g, '').replace(/\bfor\b.*/i, '').trim()
        if (address.length > 3) {
          actions.push({
            type: 'create_job',
            entities: {
              address,
              ...(clientMatch ? { client_name: clientMatch[1].trim() } : {}),
            },
            confidence: 88,
          })
        }
      }
    }
  }

  // Crew bulk add — "My crew: Jack (carpenter), Mick (plumber), Sarah (tiler)"
  const crewBulkMatch = lower.match(/(?:my crew|my team|my workers|my staff)[:\s]+(.+)/i)
  if (crewBulkMatch && !actions.some(a => a.type === 'add_worker')) {
    const crewList = crewBulkMatch[1]
    const crewEntries = crewList.split(/,\s*/).map(s => s.trim()).filter(Boolean)
    for (const entry of crewEntries) {
      const roleMatch = entry.match(/\(([^)]+)\)/)
      const rawName = entry.replace(/\([^)]+\)/g, '').trim()
      if (rawName && roleMatch) {
        const name = rawName.charAt(0).toUpperCase() + rawName.slice(1)
        actions.push({ type: 'add_worker', entities: { name, role: roleMatch[1].toLowerCase() }, confidence: 88 })
      }
    }
  }

  // New job — extract address, client, budget, scope (single job)
  const newJobMatch = lower.match(/(?:new\s+(?:job|rear|kitchen|bathroom|renovation|extension|project|build)\s+at|create\s+(?:a\s+)?job\s+at|job\s+at)\s+(.+?)(?:\s+for|\s+client|\s+budget|\s+help|\s+quote|\s+start|,|$)/i)
  const forceMatch = lower.includes('create job anyway')
  if ((newJobMatch || forceMatch) && !actions.some(a => a.type === 'create_job')) {
    const rawAddress = newJobMatch ? newJobMatch[1].trim() : 'unknown address'
    // Extract client name
    const clientMatch = message.match(/(?:for|client)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i)
    // Extract budget hint (strip non-numeric)
    const budgetMatch = message.match(/(?:budget|around|approx\.?|~)\s*\$?([\d,]+)/i)
    // Extract scope
    const scopeMatch = message.match(/(?:rear extension|kitchen|bathroom|renovation|extension|addition|reno)/i)
    actions.push({
      type: 'create_job',
      entities: {
        address: rawAddress,
        ...(clientMatch ? { client_name: clientMatch[1] } : {}),
        ...(budgetMatch ? { budget_hint: budgetMatch[1].replace(/,/g, '') } : {}),
        ...(scopeMatch ? { scope_notes: scopeMatch[0] } : {}),
      },
      confidence: 95,
    })
  }

  // Upload plans mentioned — skip uncertain/hedged language
  const uncertainPlan =
    lower.includes('somewhere') ||
    lower.includes('at the office') ||
    lower.includes('think i have') ||
    lower.includes("think i've") ||
    lower.includes('not sure if') ||
    lower.includes('not uploaded') ||
    lower.includes("haven't uploaded") ||
    lower.includes('havent uploaded')
  if (!uncertainPlan && (lower.includes('upload') || lower.includes('plans') || lower.includes('drawings'))) {
    if (!actions.some((a) => a.type === 'create_job')) {
      actions.push({ type: 'open_upload_panel', entities: {}, confidence: 85 })
    }
  }

  // Assumptions review (also triggered by "I uploaded/I've uploaded the plans")
  const definitePlanUpload = lower.includes('uploaded') && lower.includes('plan') && !uncertainPlan
  if (
    lower.includes('assumption') ||
    lower.includes('assumptions') ||
    lower.includes('unresolved') ||
    lower.includes('what needs resolving') ||
    lower.includes('before we can issue') ||
    lower.includes('before we quote') ||
    definitePlanUpload
  ) {
    actions.push({ type: 'review_assumptions', entities: {}, confidence: 85 })
  }

  // Add worker — single add; skip if crew bulk already matched
  const addMatch = lower.match(/(?:^|\s)add\s+([a-z]+)(?:\s|,)/)
  const roleMatch = lower.match(/(?:he(?:'s|s)|she(?:'s|s)|is\s+a|they(?:'re|re|'re)\s+a|a)\s+(\w+)/i)
  const isAddWorkerIntent = addMatch && roleMatch && !lower.includes('task') && !lower.includes('rate') && !lower.includes('price') && !lower.includes('database') && !actions.some(a => a.type === 'add_worker')
  if (isAddWorkerIntent) {
    const demoName = addMatch[1].charAt(0).toUpperCase() + addMatch[1].slice(1)
    const demoRole = roleMatch ? roleMatch[1].toLowerCase() : 'worker'
    actions.push({ type: 'add_worker', entities: { name: demoName, role: demoRole }, confidence: 90 })
  }

  // Variation
  if (
    lower.includes('variation') ||
    lower.includes('change order') ||
    lower.includes('scope change') ||
    lower.includes('show me the variations')
  ) {
    actions.push({ type: 'variation', entities: {}, confidence: 85 })
  }

  // Invoice
  if (lower.includes('invoice') || lower.includes('payment') || lower.includes('overdue') || lower.includes('chase')) {
    actions.push({ type: 'invoice', entities: {}, confidence: 85 })
  }

  // Email draft
  if (
    lower.includes('email') ||
    lower.includes('draft') ||
    lower.includes('follow up') ||
    lower.includes('follow-up') ||
    lower.includes('message the') ||
    lower.includes('send a message')
  ) {
    const fitzroy = lower.includes('henderson') || lower.includes('fitzroy') || lower.includes('merri')
    const toorak = lower.includes('caruso') || lower.includes('tom') || lower.includes('toorak') || lower.includes('burnside')
    const invoiceHint = lower.includes('invoice') || lower.includes('payment') || lower.includes('chase')
    const quoteHint = lower.includes('quote') || lower.includes('follow up') || lower.includes('follow-up')
    actions.push({
      type: 'email_draft',
      entities: {
        recipient_name: fitzroy ? 'the Hendersons' : toorak ? 'Tom Caruso' : '',
        job_reference: fitzroy ? 'Fitzroy' : toorak ? 'Toorak' : '',
        intent_hint: invoiceHint ? 'invoice' : quoteHint ? 'quote_followup' : 'general',
      },
      confidence: 80,
    })
  }

  // Email sync status
  if (
    (lower.includes('email') && lower.includes('connected')) ||
    (lower.includes('email') && lower.includes('sync')) ||
    lower === 'email sync status'
  ) {
    actions.push({ type: 'email_sync_status', entities: {}, confidence: 90 })
  }

  // Simulate email
  if ((lower.includes('simulate') && lower.includes('email')) || (lower.includes('test') && lower.includes('email'))) {
    actions.push({ type: 'simulate_email', entities: {}, confidence: 90 })
  }

  // Margin query
  if (
    lower.includes('margin') ||
    lower.includes('profit') ||
    lower.includes('bleeding') ||
    lower.includes('losing money') ||
    lower.includes('cost overrun') ||
    lower.includes('which job is')
  ) {
    actions.push({ type: 'margin_query', entities: {}, confidence: 85 })
  }

  // Job query — known jobs by keyword
  const demoJob = findDemoJob({ address: lower })
  if (
    demoJob &&
    !actions.some((a) => a.type === 'create_job') &&
    !actions.some((a) => a.type === 'morning_brief')
  ) {
    actions.push({ type: 'job_query', entities: { address: lower }, confidence: 80 })
  }

  // Activate
  if (
    lower.includes('activate') ||
    (lower.includes('toorak') && (lower.includes('go') || lower.includes('start') || lower.includes('kick off')))
  ) {
    if (!actions.some((a) => a.type === 'job_query')) {
      actions.push({ type: 'job_query', entities: { address: 'toorak' }, confidence: 80 })
    }
  }

  // Task assignment — only trigger for imperative creation, not capability questions
  const isTaskCapabilityQuestion =
    lower.includes('can you') || lower.includes('how do') || lower.includes('how to') ||
    lower.includes('able to') || lower.includes('what can') || lower.includes('what else') ||
    lower.includes('is there') || lower.includes('do you')
  const isImperativeTask =
    lower.match(/add task/) ||
    lower.match(/assign\s+\w+\s+to/) ||
    lower.match(/schedule\s+\w+\s+to/) ||
    lower.match(/remind\s+\w+\s+to/) ||
    lower.match(/task(?:\s+to\s|\s+for\s|\s+at\s|\s*:)/)
  if (isImperativeTask && !isTaskCapabilityQuestion && !actions.some((a) => a.type === 'add_task')) {
    const descMatch = lower.match(/(?:add task|task)(?:\s+to\s+\S+)?:\s*(.+)/i)
    const assignMatch = lower.match(/assign\s+\w+\s+to\s+(?:do\s+)?(.+)/i)
    const remindMatch = lower.match(/remind\s+(\w+)\s+to\s+(.+?)(?:\s+at\s+|\s+on\s+|\s+for\s+|$)/i)
    const desc = descMatch?.[1] ?? assignMatch?.[1] ?? (remindMatch ? remindMatch[2] : undefined)
    const assignee = remindMatch ? remindMatch[1].charAt(0).toUpperCase() + remindMatch[1].slice(1) : undefined
    actions.push({ type: 'add_task', entities: { ...(desc ? { description: desc } : {}), ...(assignee ? { assignee_name: assignee } : {}) }, confidence: 75 })
  }

  // Rate / pricing upload
  if (
    (lower.includes('upload') || lower.includes('import') || lower.includes('add')) &&
    (lower.includes('rate') || lower.includes('price') || lower.includes('pricing') || lower.includes('past quote') || lower.includes('database') || lower.includes('data'))
  ) {
    if (!actions.some((a) => a.type === 'upload_rates')) {
      actions.push({ type: 'upload_rates', entities: {}, confidence: 80 })
    }
  }

  // Client history lookup
  if (
    (lower.includes('done work for') || lower.includes('worked with') || lower.includes('client history') ||
     lower.includes('before with') || (lower.includes('client') && lower.includes('before')))
  ) {
    const nameMatch = lower.match(/(?:for|with)\s+([a-z]+(?:\s+[a-z]+)?)/i)
    actions.push({ type: 'client_lookup', entities: { client_name: nameMatch?.[1] ?? '' }, confidence: 80 })
  }

  // Meeting prep
  if (
    lower.includes('meeting with') || lower.includes('heading into a meeting') ||
    lower.includes('about to meet') || lower.includes('give me everything') ||
    (lower.includes('before i meet') || lower.includes('before the meeting'))
  ) {
    const nameMatch = lower.match(/(?:meeting with|meet)\s+([a-z]+(?:\s+[a-z]+)?)/i)
    const addrMatch = lower.match(/(?:for|on|about)\s+(?:the\s+)?([a-z]+(?:\s+st|street|rd|road|ave|avenue)?)/i)
    actions.push({
      type: 'meeting_prep',
      entities: {
        ...(nameMatch ? { client_name: nameMatch[1] } : {}),
        ...(addrMatch && !nameMatch ? { job_address: addrMatch[1] } : {}),
      },
      confidence: 90,
    })
  }

  // Payment risk / cashflow
  if (
    lower.includes('getting paid') || lower.includes('payment risk') ||
    lower.includes('stop me') || lower.includes('most likely to') ||
    lower.includes('at risk of') || lower.includes('wont get paid') || lower.includes('won\'t get paid') ||
    lower.includes('cashflow') || lower.includes('cash flow')
  ) {
    if (!actions.some(a => a.type === 'payment_risk')) {
      actions.push({ type: 'payment_risk', entities: {}, confidence: 90 })
    }
  }

  // Worker onboarding — "Jack starts Monday", "what does [name] need before site"
  const onboardMatch = lower.match(/([a-z]+)\s+starts?\s+(monday|tuesday|wednesday|thursday|friday|next week|this week)/i)
    || lower.match(/what\s+does\s+([a-z]+)\s+need/i)
    || lower.match(/([a-z]+)\s+is\s+starting/i)
  if (onboardMatch && !actions.some(a => a.type === 'worker_onboarding')) {
    const rawName = onboardMatch[1]
    const name = rawName.charAt(0).toUpperCase() + rawName.slice(1)
    const dateMatch = lower.match(/(monday|tuesday|wednesday|thursday|friday|next week|this week)/i)
    actions.push({ type: 'worker_onboarding', entities: { name, ...(dateMatch ? { start_date: dateMatch[1] } : {}) }, confidence: 88 })
  }

  // Roadmap / what's coming
  if (
    lower.includes('coming to worka') || lower.includes('coming to work a') ||
    lower.includes('roadmap') || lower.includes("what's planned") || lower.includes('whats planned') ||
    lower.includes('future features') || lower.includes('what will worka') ||
    lower.includes('list everything') || lower.includes('whats coming') || lower.includes("what's coming") ||
    (lower.includes('coming') && (lower.includes('worka') || lower.includes('work a') || lower.includes('features')))
  ) {
    if (!actions.some(a => a.type === 'roadmap')) {
      actions.push({ type: 'roadmap', entities: {}, confidence: 90 })
    }
  }

  // Team chat / notifications
  if (
    lower.includes('team chat') || lower.includes('team message') || lower.includes('team notif') ||
    lower.includes('notify workers') || lower.includes('notify crew') || lower.includes('notify staff') ||
    lower.includes('push notification') || lower.includes('group chat') ||
    (lower.includes('message') && (lower.includes('crew') || lower.includes('workers') || lower.includes('staff'))) ||
    (lower.includes('notification') && (lower.includes('worker') || lower.includes('crew') || lower.includes('team')))
  ) {
    if (!actions.some(a => a.type === 'team_notifications')) {
      actions.push({ type: 'team_notifications', entities: {}, confidence: 88 })
    }
  }

  // Contradiction detection — must run AFTER other detections so it can clear conflicting actions
  const hasNegation = lower.includes('actually') || lower.includes("don't") || lower.includes('dont') ||
    lower.includes('not yet') || lower.includes('still deciding') || lower.includes('hold on') || lower.includes('wait')
  const hasAffirmation = lower.includes('approved') || lower.includes('mark') || lower.includes('update') || lower.includes('complete')
  if (hasNegation && hasAffirmation && actions.some(a => a.type === 'variation' || a.type === 'invoice')) {
    // Clear the conflicting actions — safer than executing both
    const filtered = actions.filter(a => a.type !== 'variation' && a.type !== 'invoice')
    actions.length = 0
    filtered.forEach(a => actions.push(a))
    actions.push({
      type: 'conflict_detected',
      entities: {
        statement_a: lower.includes('approved') ? 'variation/status approved' : 'status updated',
        statement_b: lower.includes('not yet') || lower.includes('still deciding') ? 'still deciding — not yet approved' : 'correction given',
        entity_type: 'variation',
      },
      confidence: 88,
    })
  }

  // Fallback
  if (actions.length === 0) {
    actions.push({ type: 'unknown', entities: {}, confidence: 100 })
  }

  const ctx: OrchestrationContext = {
    builder_id: builderId,
    force_create: forceCreate,
    resolved_job_id: null,
    resolved_job: null,
    is_duplicate: false,
  }

  // Pass null — orchestrator void-suppress it, no AI calls needed
  return orchestrateActions(actions, ctx, null as unknown as Anthropic)
}

// ─── POST Handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse<ChatResponse>> {
  try {
    const body = (await request.json()) as ChatRequestBody
    const message = body.message?.trim()
    const builderId = body.builder_id ?? '00000000-0000-0000-0000-000000000001'
    const forceCreate = body.force_create === true

    if (!message) {
      return NextResponse.json(
        { intent: 'unknown', message: 'Please type a message.' },
        { status: 400 }
      )
    }

    const apiKey = process.env.ANTHROPIC_API_KEY

    if (!apiKey) {
      const result = await routeDemoMessage(message, builderId, forceCreate)
      return NextResponse.json(result)
    }

    const lowerMsg = message.toLowerCase()

    // Pre-extract fast path: worker/staff/crew listing bypasses LLM extraction
    // Excluded: how-to questions, removal/deletion requests — those go through the AI
    const isActionableWorkerQuestion =
      lowerMsg.includes('remove') ||
      lowerMsg.includes('delete') ||
      lowerMsg.includes('fire') ||
      lowerMsg.includes('how do i') ||
      lowerMsg.includes('how to') ||
      lowerMsg.includes('can i') ||
      lowerMsg.includes('am i able')
    if (
      !isActionableWorkerQuestion &&
      (
        lowerMsg.includes('list workers') ||
        lowerMsg.includes('show workers') ||
        lowerMsg.includes('show my workers') ||
        lowerMsg.includes('show my crew') ||
        lowerMsg.includes('show my team') ||
        lowerMsg.includes('my workers') ||
        lowerMsg.includes('my crew') ||
        lowerMsg.includes('my team') ||
        (lowerMsg.includes('list') && lowerMsg.includes('worker')) ||
        (lowerMsg.includes('who') && (lowerMsg.includes('crew') || lowerMsg.includes('worker') || lowerMsg.includes('team'))) ||
        lowerMsg === 'staff'
      )
    ) {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (supabaseUrl && serviceRoleKey) {
        const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
        const { data: workers } = await supabase
          .from('workers')
          .select('id, name, role, status, email, phone')
          .eq('builder_id', builderId)
          .neq('status', 'inactive')
          .order('created_at', { ascending: false })
          .limit(50)
        if (workers && workers.length > 0) {
          const typedWorkers = workers as WorkerListItem[]
          return NextResponse.json({
            intent: 'job_query',
            message: `${typedWorkers.length} worker${typedWorkers.length === 1 ? '' : 's'} on your crew. Tap a name to edit details or assign a task.`,
            worker_list: typedWorkers,
          })
        }
        return NextResponse.json({
          intent: 'job_query',
          message: 'No workers on your crew yet. Type "add Jack, he\'s a carpenter" to invite your first one.',
        })
      }
      return NextResponse.json({
        intent: 'job_query',
        message: '2 workers on your crew. Tap a name to edit details or assign a task.',
        worker_list: [
          { id: 'w-jack-001', name: 'Jack Thompson', role: 'Carpenter', status: 'invited', email: null, phone: null },
          { id: 'w-mick-002', name: 'Mick Reynolds', role: 'Plumber', status: 'invited', email: null, phone: null },
        ] as WorkerListItem[],
      })
    }

    // Pre-extract fast path: job listing bypasses LLM extraction
    const isJobListQuery =
      lowerMsg === 'show my jobs' || lowerMsg === 'my jobs' || lowerMsg === 'list jobs' ||
      lowerMsg.includes('show my jobs') || lowerMsg.includes('list my jobs') ||
      lowerMsg.includes('lost my jobs') || lowerMsg.includes('where are my jobs') ||
      (lowerMsg.includes('show') && lowerMsg.includes('job') && !lowerMsg.includes('quote') && !lowerMsg.includes('invoice')) ||
      (lowerMsg.includes('list') && lowerMsg.includes('job') && !lowerMsg.includes('quote'))
    if (isJobListQuery) {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (supabaseUrl && serviceRoleKey) {
        const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
        const { data: jobs } = await supabase
          .from('jobs')
          .select('id, address, status, job_ref')
          .eq('builder_id', builderId)
          .not('status', 'eq', 'archived')
          .order('created_at', { ascending: false })
          .limit(20)
        if (jobs && jobs.length > 0) {
          const jobItems = jobs as Array<{ id: string; address: string; status: string; job_ref: string | null }>
          return NextResponse.json({
            intent: 'job_query',
            message: `You have ${jobItems.length} active job${jobItems.length === 1 ? '' : 's'}. Tap one to open it.`,
            job_list: jobItems.map(j => ({ id: j.id, address: j.address, status: j.status, job_ref: j.job_ref })),
          })
        }
        return NextResponse.json({
          intent: 'job_query',
          message: 'No active jobs yet. Type "new job at [address]" to create your first one.',
        })
      }
      // Supabase URL present but no service role key — return demo list rather than falling through silently
      return NextResponse.json({
        intent: 'job_query',
        message: `You have ${DEMO_JOB_LIST.length} active jobs. Tap one to open it.`,
        job_list: DEMO_JOB_LIST,
      })
    }

    const anthropic = new Anthropic({ apiKey })

    // Extract all actions from the message
    const actions = await extractActions(message, anthropic)

    const ctx: OrchestrationContext = {
      builder_id: builderId,
      force_create: forceCreate,
      resolved_job_id: null,
      resolved_job: null,
      is_duplicate: false,
    }

    const result = await orchestrateActions(actions, ctx, anthropic)
    if (result.intent === 'unknown') {
      return NextResponse.json(await smartFallback(message, builderId, anthropic))
    }
    return NextResponse.json(result)
  } catch (err) {
    console.error('[/api/chat] Error:', err)
    return NextResponse.json(
      { intent: 'unknown', message: 'Something went wrong — please try again.' },
      { status: 500 }
    )
  }
}
