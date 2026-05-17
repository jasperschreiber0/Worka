import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import type {
  IntentType,
  Invoice,
  Variation,
  Quote,
  Job,
} from '@/lib/types/database.types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatRequestBody {
  message: string
  builder_id?: string
}

interface Alert {
  priority: 'high' | 'medium' | 'low'
  message: string
  action?: string
  entity_id?: string
  entity_type?: 'job' | 'invoice' | 'variation' | 'quote'
}

interface ChatResponse {
  intent: string
  message: string
  alerts?: Alert[]
  event?: {
    type: string
    [key: string]: unknown
  }
}

interface ClassifyResult {
  intent: IntentType
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
- new_job: starting a new job, new quote, new project at an address
- job_query: asking about a specific job, project status, or client
- variation: variation requests, change orders, scope changes
- invoice: invoices, payments, billing queries
- unknown: anything that doesn't fit the above

Extract relevant entities:
- For add_worker: name, role
- For new_job: address, client_name (if mentioned)
- For job_query: address or job name
- For variation/invoice: job reference if mentioned

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

// ─── Intent Handlers ──────────────────────────────────────────────────────────

function handleAddWorker(entities: Record<string, string>): ChatResponse {
  const name = entities.name ? ` for ${entities.name}` : ''
  const role = entities.role ? ` (${entities.role})` : ''
  return {
    intent: 'add_worker',
    message: `Got it — adding a worker${name}${role} is coming in the next update. Type "whats on today" to see your morning brief.`,
  }
}

function handleNewJob(entities: Record<string, string>): ChatResponse {
  const address = entities.address ? ` at ${entities.address}` : ''
  return {
    intent: 'new_job',
    message: `Got it — creating a new job${address} is coming in the next update. Type "whats on today" to see your morning brief.`,
  }
}

function handleJobQuery(entities: Record<string, string>): ChatResponse {
  const ref = entities.address ?? entities.job_name ?? ''
  return {
    intent: 'job_query',
    message: ref
      ? `Job details for ${ref} are coming in a future update. Type "whats on today" to see your morning brief.`
      : 'Job details are coming in a future update. Type "whats on today" to see your morning brief.',
  }
}

function handleVariation(): ChatResponse {
  return {
    intent: 'variation',
    message: 'Variation management is coming in a future update. Type "whats on today" to see your morning brief.',
  }
}

function handleInvoice(): ChatResponse {
  return {
    intent: 'invoice',
    message: 'Invoice management is coming in a future update. Type "whats on today" to see your morning brief.',
  }
}

function handleUnknown(): ChatResponse {
  return {
    intent: 'unknown',
    message: 'I\'m not sure what you mean. Try typing "whats on today" to see your morning brief, or ask me about a job.',
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
      // No API key — still return demo brief for morning_brief keywords, else fallback
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
      return NextResponse.json(handleUnknown())
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
      return NextResponse.json(handleAddWorker(classified.entities))
    }

    if (classified.intent === 'new_job') {
      return NextResponse.json(handleNewJob(classified.entities))
    }

    if (classified.intent === 'job_query') {
      return NextResponse.json(handleJobQuery(classified.entities))
    }

    if (classified.intent === 'variation') {
      return NextResponse.json(handleVariation())
    }

    if (classified.intent === 'invoice') {
      return NextResponse.json(handleInvoice())
    }

    return NextResponse.json(handleUnknown())
  } catch (err) {
    console.error('[/api/chat] Error:', err)
    return NextResponse.json(
      { intent: 'unknown', message: 'Something went wrong — please try again.' },
      { status: 500 }
    )
  }
}
