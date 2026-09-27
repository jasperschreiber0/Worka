/**
 * morning-brief — Layer 2 Decision (Backend)
 *
 * Generates a ranked morning brief for the builder.
 * Queries Supabase for active jobs, pending variations, overdue invoices,
 * and pending quote follow-ups. Returns plain-English alerts — zero raw
 * data in the UI.
 *
 * Input:  POST { builder_id: string }
 * Output: { brief: string, alerts: Alert[] }
 *
 * Alert priority ranking:
 *   1. high   — overdue invoices
 *   2. high   — pending variations awaiting approval
 *   3. medium — active jobs needing attention (no recent activity)
 *   4. medium — quotes sent > 7 days ago with no response
 *   5. low    — general active job count summary
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── Types ────────────────────────────────────────────────────

interface MorningBriefRequest {
  builder_id: string
}

interface Alert {
  priority: 'high' | 'medium' | 'low'
  message: string
  href?: string
  action?: string
  entity_id?: string
  entity_type?: string
}

interface MorningBriefResponse {
  brief: string
  alerts: Alert[]
}

// DB row shapes (only the columns we need)
interface JobRow {
  id: string
  address: string
  status: string
  updated_at: string
  client?: { name: string } | null
}

interface VariationRow {
  id: string
  title: string
  amount: number | null
  status: string
  created_at: string
  job?: { address: string } | null
}

interface InvoiceRow {
  job_id: string
  id: string
  amount: number
  status: string
  due_date: string | null
  sent_at: string | null
  job?: { address: string; client?: { name: string } | null } | null
}

interface QuoteRow {
  job_id: string
  id: string
  status: string
  sent_at: string | null
  job?: { address: string; client?: { name: string } | null } | null
}

// ─── CORS headers ─────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function corsResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// ─── Helpers ──────────────────────────────────────────────────

function daysBetween(a: string | null, b: Date = new Date()): number {
  if (!a) return 0
  return Math.floor((b.getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24))
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 })
    .format(n)
}

function jobLabel(row: JobRow): string {
  if (row.client?.name) return `the ${row.client.name} job`
  // Extract suburb or street from address
  const parts = row.address.split(',')
  const street = parts[0]?.trim() ?? row.address
  return `the job at ${street}`
}

function invoiceJobLabel(row: InvoiceRow): string {
  if (row.job?.client?.name) return `the ${row.job.client.name} job`
  if (row.job?.address) {
    const parts = row.job.address.split(',')
    return `the job at ${parts[0]?.trim() ?? row.job.address}`
  }
  return 'a job'
}

// ─── Handler ──────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405)
  }

  let body: MorningBriefRequest
  try {
    body = await req.json() as MorningBriefRequest
  } catch {
    return corsResponse(JSON.stringify({ error: 'Invalid JSON body' }), 400)
  }

  const { builder_id } = body
  if (!builder_id || typeof builder_id !== 'string') {
    return corsResponse(JSON.stringify({ error: 'builder_id is required' }), 400)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !supabaseServiceKey) {
    return corsResponse(JSON.stringify({ error: 'Supabase environment variables not configured' }), 500)
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    const now = new Date()
    const alerts: Alert[] = []

    // ── 1. Overdue invoices (highest priority) ────────────────
    const { data: overdueInvoices } = await supabase
      .from('invoices')
      .select('id, job_id, amount, status, due_date, sent_at, job:jobs(address, client:clients(name))')
      .eq('builder_id', builder_id)
      .in('status', ['sent', 'overdue'])
      .not('due_date', 'is', null)
      .lt('due_date', new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(now)).throwOnError() // past due date

    for (const inv of (overdueInvoices ?? []) as unknown as InvoiceRow[]) {
      const daysOver = daysBetween(inv.due_date, now)
      const label = invoiceJobLabel(inv)
      const amount = formatCurrency(inv.amount)
      const dayWord = daysOver === 1 ? 'day' : 'days'
      alerts.push({
        priority: 'high',
        message: `${label} has an invoice for ${amount} recorded as ${daysOver} ${dayWord} overdue.`,
        action: 'Review recorded invoice and payment status',
        href: `/jobs/${inv.job_id}?section=money`,
        entity_id: inv.id,
        entity_type: 'invoice',
      })
    }

    // ── 2. Pending variations awaiting approval ───────────────
    const { data: pendingVariations } = await supabase
      .from('variations')
      .select('id, title, amount, status, created_at, job:jobs(address)')
      .eq('builder_id', builder_id)
      .eq('status', 'pending').throwOnError()

    for (const v of (pendingVariations ?? []) as unknown as VariationRow[]) {
      const daysWaiting = daysBetween(v.created_at, now)
      const jobAddr = v.job?.address
        ? `the job at ${v.job.address.split(',')[0]?.trim()}`
        : 'a job'
      const amountStr = v.amount ? ` for ${formatCurrency(v.amount)}` : ''
      const dayWord = daysWaiting === 1 ? 'day' : 'days'
      alerts.push({
        priority: 'high',
        message: `Variation "${v.title}"${amountStr} on ${jobAddr} has a pending approval record for ${daysWaiting} ${dayWord}.`,
        action: 'Review approval evidence',
        href: `/variations/${v.id}/review`,
        entity_id: v.id,
        entity_type: 'variation',
      })
    }

    // ── 3. Quotes sent > 7 days ago with no response ──────────
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: staleSentQuotes } = await supabase
      .from('quotes')
      .select('id, job_id, status, sent_at, job:jobs(address, client:clients(name))')
      .eq('builder_id', builder_id)
      .eq('status', 'sent')
      .lt('sent_at', sevenDaysAgo).throwOnError()

    for (const q of (staleSentQuotes ?? []) as unknown as QuoteRow[]) {
      const daysSent = daysBetween(q.sent_at, now)
      const label = q.job?.client?.name
        ? `to ${q.job.client.name}`
        : q.job?.address
          ? `for ${q.job.address.split(',')[0]?.trim()}`
          : ''
      const dayWord = daysSent === 1 ? 'day' : 'days'
      alerts.push({
        priority: 'medium',
        message: `A quote sent ${label} ${daysSent} ${dayWord} ago has had no response yet.`,
        action: 'Review quote and follow-up',
        href: `/jobs/${q.job_id}`,
        entity_id: q.id,
        entity_type: 'quote',
      })
    }

    // ── 4. Active jobs with no updates in > 5 days ────────────
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString()
    const { data: staleJobs } = await supabase
      .from('jobs')
      .select('id, address, status, updated_at, client:clients(name)')
      .eq('builder_id', builder_id)
      .eq('status', 'active')
      .lt('updated_at', fiveDaysAgo).throwOnError()

    for (const j of (staleJobs ?? []) as unknown as JobRow[]) {
      const daysStale = daysBetween(j.updated_at, now)
      const label = jobLabel(j)
      const dayWord = daysStale === 1 ? 'day' : 'days'
      alerts.push({
        priority: 'medium',
        message: `${label.charAt(0).toUpperCase() + label.slice(1)} has had no updates for ${daysStale} ${dayWord}.`,
        action: 'Review job progress',
        href: `/jobs/${j.id}`,
        entity_id: j.id,
        entity_type: 'job',
      })
    }

    // ── 5. Summary: active job count ─────────────────────────
    const { count: activeJobCount } = await supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('builder_id', builder_id)
      .eq('status', 'active').throwOnError()

    if ((activeJobCount ?? 0) > 0) {
      const jobWord = activeJobCount === 1 ? 'job' : 'jobs'
      alerts.push({
        priority: 'low',
        message: `You have ${activeJobCount} active ${jobWord} on the go.`,
        entity_type: 'summary',
      })
    }

    // ── 6. Quoting pipeline count ─────────────────────────────
    const { count: quotingCount } = await supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('builder_id', builder_id)
      .eq('status', 'quoting').throwOnError()

    if ((quotingCount ?? 0) > 0) {
      const jobWord = quotingCount === 1 ? 'job' : 'jobs'
      alerts.push({
        priority: 'low',
        message: `${quotingCount} ${jobWord} in the quoting pipeline.`,
        entity_type: 'summary',
      })
    }

    // Give draft estimates a named, directly linked next step.
    const {data: drafts} = await supabase.from('quotes')
      .select('id,job_id,status,job:jobs(address,status),quote_line_items(total,is_assumption,assumption_status)')
      .eq('builder_id',builder_id).eq('is_current',true).in('status',['draft','pending_review']).throwOnError()
    for (const draft of (drafts ?? []) as unknown as Array<{id:string;job_id:string;job:{address:string;status:string}|null;quote_line_items:Array<{total:number|null;is_assumption:boolean;assumption_status:string|null}>}>) {
      if (!draft.job || ['archived','complete'].includes(draft.job.status)) continue
      const included=draft.quote_line_items.filter(i=>i.assumption_status!=='excluded')
      const prices=included.filter(i=>i.total===null).length
      const assumptions=included.filter(i=>i.is_assumption&&i.assumption_status==='unresolved').length
      const detail=[prices?`${prices} missing price${prices===1?'':'s'}`:'',assumptions?`${assumptions} assumption${assumptions===1?'':'s'} to review`:''].filter(Boolean).join(' and ')
      alerts.push({priority:'medium',message:`${draft.job.address}: ${detail || 'draft estimate needs your review before issue'}.`,action:'Continue estimate review',href:`/jobs/${draft.job_id}`,entity_id:draft.id,entity_type:'quote'})
    }

    // ── Build brief summary string ────────────────────────────
    const highCount = alerts.filter((a) => a.priority === 'high').length
    const mediumCount = alerts.filter((a) => a.priority === 'medium').length

    let brief: string
    if (alerts.length === 0) {
      brief = 'No urgent items found in the records checked. Missing or outdated records may hide work that needs attention.'
    } else if (highCount === 0 && mediumCount === 0) {
      brief = `No urgent items found in the records checked. ${alerts.length} low-priority update${alerts.length > 1 ? 's' : ''} for your attention.`
    } else {
      const parts: string[] = []
      if (highCount > 0) parts.push(`${highCount} urgent item${highCount > 1 ? 's' : ''}`)
      if (mediumCount > 0) parts.push(`${mediumCount} item${mediumCount > 1 ? 's' : ''} needing attention`)
      brief = `Good morning — you have ${parts.join(' and ')} today.`
    }

    const result: MorningBriefResponse = { brief, alerts }
    return corsResponse(JSON.stringify(result))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('morning-brief error:', msg)
    return corsResponse(JSON.stringify({ error: 'Failed to generate morning brief', detail: msg }), 500)
  }
})
