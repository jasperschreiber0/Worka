import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import Anthropic from '@anthropic-ai/sdk'
import { getDemoJobSnapshot } from '@/lib/job-snapshot-demo'

// ─── Types ────────────────────────────────────────────────────────────────────

type IntentHint = 'invoice' | 'quote_followup' | 'variation' | 'general'

interface EmailDraftRequestBody {
  builder_id: string
  job_id?: string
  recipient_name?: string
  intent_hint?: IntentHint
  context?: string
}

interface EmailDraft {
  to: string
  to_name: string
  subject: string
  body: string
  job_id: string | null
  job_address: string | null
}

interface ContextUsed {
  job_address: string | null
  client_name: string | null
  intent_hint: IntentHint
}

interface EmailDraftResponse {
  draft: EmailDraft
  context_used: ContextUsed
  requires_confirmation: true
}

// ─── Demo builder data ────────────────────────────────────────────────────────

const DEMO_BUILDER = {
  name: 'Dave Nguyen',
  business_name: 'Nguyen Constructions',
  email: 'dave@nguyenconstructions.com.au',
}

// ─── Job context loader ───────────────────────────────────────────────────────

interface JobContext {
  job_id: string
  job_address: string
  client_name: string
  client_email: string
  invoice_amount: number | null
  invoice_status: string | null
  invoice_days_overdue: number | null
  quote_amount: number | null
  quote_sent_display: string | null
  latest_variation_title: string | null
  latest_variation_amount: number | null
}

function loadDemoJobContext(jobId: string): JobContext | null {
  const snapshot = getDemoJobSnapshot(jobId)
  if (!snapshot) return null

  const invoice = snapshot.invoices[0] ?? null
  const variation = snapshot.variations.find((v) => v.status === 'pending') ?? null

  // Calculate days overdue from plain-English string
  let invoiceDaysOverdue: number | null = null
  if (invoice?.status === 'overdue' && invoice.due_date) {
    const match = invoice.due_date.match(/^(\d+)\s+days?\s+ago$/)
    if (match) {
      invoiceDaysOverdue = parseInt(match[1], 10)
    }
  }

  return {
    job_id: jobId,
    job_address: snapshot.job.address,
    client_name: snapshot.job.client_name ?? 'there',
    client_email: snapshot.job.client_email ?? '',
    invoice_amount: invoice?.amount ?? null,
    invoice_status: invoice?.status ?? null,
    invoice_days_overdue: invoiceDaysOverdue,
    quote_amount: snapshot.quote?.total_cost ?? null,
    quote_sent_display: snapshot.quote?.sent_at ?? null,
    latest_variation_title: variation?.title ?? null,
    latest_variation_amount: variation?.amount ?? null,
  }
}

// ─── Real builder + job loaders ───────────────────────────────────────────────

interface BuilderIdentity {
  name: string
  business_name: string
}

async function loadBuilderIdentity(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  builderId: string,
): Promise<BuilderIdentity> {
  const { data } = await sb
    .from('builders')
    .select('name, business_name')
    .eq('id', builderId)
    .single()

  return {
    name: data?.name ?? 'the WorkA team',
    business_name: data?.business_name ?? '',
  }
}

async function loadRealJobContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  jobId: string,
  builderId: string,
): Promise<JobContext | null> {
  const { data: job } = await sb
    .from('jobs')
    .select('id, address, clients(name, email)')
    .eq('id', jobId)
    .eq('builder_id', builderId)
    .single()

  if (!job) return null

  const [{ data: quotes }, { data: variations }, { data: invoices }] = await Promise.all([
    sb.from('quotes').select('total_cost, sent_at, version, status').eq('job_id', jobId).order('version', { ascending: false }).limit(1),
    sb.from('variations').select('title, amount').eq('job_id', jobId).eq('status', 'pending').order('created_at', { ascending: false }).limit(1),
    sb.from('invoices').select('amount, status, due_date').eq('job_id', jobId).order('created_at', { ascending: false }).limit(1),
  ])

  const quote = quotes?.[0] ?? null
  const variation = variations?.[0] ?? null
  const invoice = invoices?.[0] ?? null

  let invoiceDaysOverdue: number | null = null
  if (invoice?.status === 'overdue' && invoice.due_date) {
    invoiceDaysOverdue = Math.floor((Date.now() - new Date(invoice.due_date).getTime()) / (1000 * 60 * 60 * 24))
  }

  return {
    job_id: jobId,
    job_address: job.address,
    client_name: job.clients?.name ?? 'there',
    client_email: job.clients?.email ?? '',
    invoice_amount: invoice?.amount ?? null,
    invoice_status: invoice?.status ?? null,
    invoice_days_overdue: invoiceDaysOverdue,
    quote_amount: quote?.total_cost ?? null,
    quote_sent_display: quote?.sent_at ?? null,
    latest_variation_title: variation?.title ?? null,
    latest_variation_amount: variation?.amount ?? null,
  }
}

// ─── Fallback template drafts (no AI) ────────────────────────────────────────

function buildFallbackDraft(
  ctx: JobContext | null,
  intentHint: IntentHint,
  recipientName: string | undefined,
  builder: BuilderIdentity,
): EmailDraft {
  const clientName = ctx?.client_name ?? recipientName ?? 'there'
  const jobAddress = ctx?.job_address ?? 'your project'
  const builderName = builder.name
  const businessName = builder.business_name
  const toEmail = ctx?.client_email ?? ''
  const toName = clientName

  if (intentHint === 'invoice') {
    const amount = ctx?.invoice_amount != null ? `$${ctx.invoice_amount.toLocaleString('en-AU')}` : 'the outstanding amount'
    const daysOverdue = ctx?.invoice_days_overdue != null ? `${ctx.invoice_days_overdue} days overdue` : 'overdue'
    const subject = `Invoice follow-up — ${jobAddress}`
    const body = `Hi ${clientName},

I'm following up on the invoice for ${jobAddress} sent recently.
The total of ${amount} is now ${daysOverdue}.

Please let me know if you have any questions or if you'd like to arrange payment.

${builderName}
${businessName}`
    return { to: toEmail, to_name: toName, subject, body, job_id: ctx?.job_id ?? null, job_address: jobAddress }
  }

  if (intentHint === 'quote_followup') {
    const sentDisplay = ctx?.quote_sent_display ?? 'recently'
    const subject = `Quote follow-up — ${jobAddress}`
    const body = `Hi ${clientName},

I wanted to follow up on the quote I sent you ${sentDisplay} for ${jobAddress}.

Happy to answer any questions or walk through anything in more detail.

${builderName}
${businessName}`
    return { to: toEmail, to_name: toName, subject, body, job_id: ctx?.job_id ?? null, job_address: jobAddress }
  }

  if (intentHint === 'variation') {
    const varTitle = ctx?.latest_variation_title ?? 'the variation request'
    const varAmount = ctx?.latest_variation_amount != null
      ? `$${ctx.latest_variation_amount.toLocaleString('en-AU')}`
      : 'TBC'
    const subject = `Variation update — ${jobAddress}`
    const body = `Hi ${clientName},

Just following up on the variation request for ${jobAddress}.

${varTitle} — ${varAmount}

Let me know if you'd like to discuss further.

${builderName}
${businessName}`
    return { to: toEmail, to_name: toName, subject, body, job_id: ctx?.job_id ?? null, job_address: jobAddress }
  }

  // general
  const subjectLabel = ctx ? jobAddress : 'Project update'
  const subject = `${subjectLabel} — following up`
  const greeting = clientName !== 'there' ? `Hi ${clientName},` : 'Hi,'
  const projectRef = ctx ? `the work at ${jobAddress}` : 'your project'
  const body = `${greeting}

I wanted to follow up regarding ${projectRef}. Please let me know if you have any questions or if there is anything you would like to discuss.

Kind regards,
${builderName}
${businessName}`
  return { to: toEmail, to_name: toName, subject, body, job_id: ctx?.job_id ?? null, job_address: ctx?.job_address ?? null }
}

// ─── AI-generated draft ───────────────────────────────────────────────────────

async function buildAIDraft(
  ctx: JobContext | null,
  intentHint: IntentHint,
  recipientName: string | undefined,
  contextMessage: string | undefined,
  anthropic: Anthropic,
  builder: BuilderIdentity,
): Promise<EmailDraft> {
  const clientName = ctx?.client_name ?? recipientName ?? 'the client'
  const jobAddress = ctx?.job_address ?? 'the project'
  const builderName = builder.name
  const businessName = builder.business_name
  const toEmail = ctx?.client_email ?? ''

  const contextBlock = ctx
    ? `
Job: ${jobAddress}
Client: ${clientName} (${toEmail})
Status: ${ctx.invoice_status ?? 'N/A'}
${ctx.invoice_amount != null ? `Invoice amount: $${ctx.invoice_amount.toLocaleString('en-AU')}` : ''}
${ctx.invoice_days_overdue != null ? `Invoice overdue by: ${ctx.invoice_days_overdue} days` : ''}
${ctx.quote_amount != null ? `Quote amount: $${ctx.quote_amount.toLocaleString('en-AU')}` : ''}
${ctx.quote_sent_display != null ? `Quote sent: ${ctx.quote_sent_display}` : ''}
${ctx.latest_variation_title != null ? `Latest variation: ${ctx.latest_variation_title}` : ''}
${ctx.latest_variation_amount != null ? `Variation amount: $${ctx.latest_variation_amount.toLocaleString('en-AU')}` : ''}
`.trim()
    : `No specific job context. Recipient: ${clientName}`

  const intentContext: Record<IntentHint, string> = {
    invoice: 'following up on an overdue invoice',
    quote_followup: 'following up on a sent quote with no response',
    variation: 'following up on a variation request',
    general: 'general outreach regarding the project',
  }

  const hasContext = Boolean(ctx)

  const prompt = `You are helping an Australian residential builder named ${builderName} from ${businessName} draft a professional email to a client.

Job context:
${contextBlock}

Email purpose: ${intentContext[intentHint]}
${contextMessage ? `Additional context from builder: ${contextMessage}` : ''}

Write a professional, clear email that:
- Is courteous and professional — never use slang, colloquialisms, or casual greetings like "G'day", "Mate", "Hey", "Hi there"
${hasContext
  ? `- Opens with "Hi ${clientName}," using the client first name`
  : `- Opens with "Hi [name]," — but since no client name is available, use "Hi," on its own`}
${hasContext
  ? `- References the specific job at ${jobAddress} and the client's name`
  : `- Does not invent a job address or client name — write around the unknown details naturally`}
- States the purpose clearly in the first sentence
- Is concise — 3–5 sentences for follow-ups, slightly longer for detailed matters
- Uses correct Australian English spelling (not US English)
- Includes a specific subject line (not "your project — update" — make it descriptive of the actual email purpose)
- Signs off professionally with "Kind regards," or "Regards," followed by: ${builderName}\n${businessName}
- Never uses exclamation marks

IMPORTANT: Do NOT use square bracket placeholders like [Client Name], [Job Address], [Phone Number] etc.
Use the actual values from the job context. If a value is unknown, omit that detail entirely rather than using a placeholder.

Respond with ONLY valid JSON in this exact format:
{
  "subject": "the email subject line",
  "body": "the full email body text"
}`

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  })

  const content = response.content[0]
  if (content.type !== 'text') {
    return buildFallbackDraft(ctx, intentHint, recipientName, builder)
  }

  try {
    const cleaned = content.text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    const parsed = JSON.parse(cleaned) as { subject: string; body: string }
    return {
      to: toEmail,
      to_name: clientName,
      subject: parsed.subject,
      body: parsed.body,
      job_id: ctx?.job_id ?? null,
      job_address: ctx?.job_address ?? null,
    }
  } catch {
    return buildFallbackDraft(ctx, intentHint, recipientName, builder)
  }
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse<EmailDraftResponse | { error: string }>> {
  try {
    const builderId = await getAuthenticatedBuilderId()
    if (!builderId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const rateLimit = await checkRateLimit(`email-draft:${builderId}`, { limit: 30, windowSeconds: 60 })
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: 'Too many requests — please slow down and try again shortly.' }, { status: 429 })
    }

    const body = (await request.json()) as EmailDraftRequestBody
    const { job_id, recipient_name, intent_hint = 'general', context } = body

    // Load builder identity + job context — demo mode uses the seeded demo
    // data, real mode looks up the authenticated builder's actual profile
    // and the actual job (previously this always used DEMO_BUILDER and the
    // demo-only job snapshot, so real builders got "Dave Nguyen" sign-offs
    // and generic drafts with no real job context).
    let builder: BuilderIdentity
    let jobCtx: JobContext | null

    if (isDemoMode()) {
      builder = DEMO_BUILDER
      jobCtx = job_id ? loadDemoJobContext(job_id) : null
    } else {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!supabaseUrl || !serviceRoleKey) {
        return NextResponse.json({ error: 'Not configured' }, { status: 503 })
      }
      const sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
      builder = await loadBuilderIdentity(sb, builderId)
      jobCtx = job_id ? await loadRealJobContext(sb, job_id, builderId) : null
    }

    const contextUsed: ContextUsed = {
      job_address: jobCtx?.job_address ?? null,
      client_name: jobCtx?.client_name ?? recipient_name ?? null,
      intent_hint,
    }

    const apiKey = process.env.ANTHROPIC_API_KEY
    let draft: EmailDraft

    if (apiKey) {
      const anthropic = new Anthropic({ apiKey })
      draft = await buildAIDraft(jobCtx, intent_hint, recipient_name, context, anthropic, builder)
    } else {
      draft = buildFallbackDraft(jobCtx, intent_hint, recipient_name, builder)
    }

    return NextResponse.json({
      draft,
      context_used: contextUsed,
      requires_confirmation: true,
    })
  } catch (err) {
    console.error('[/api/email-draft] Error:', err)
    return NextResponse.json({ error: 'Failed to generate email draft' }, { status: 500 })
  }
}
