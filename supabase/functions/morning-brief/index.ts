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
  id: string
  amount: number
  status: string
  due_date: string | null
  sent_at: string | null
  job?: { address: string; client?: { name: string } | null } | null
}

interface QuoteRow {
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
      .select('id, amount, status, due_date, sent_at, job:jobs(address, client:clients(name))')
      .eq('builder_id', builder_id)
      .in('status', ['sent', 'overdue'])
      .not('due_date', 'is', null)
      .lt('due_date', now.toISOString().split('T')[0]) // past due date

    for (const inv of (overdueInvoices ?? []) as unknown as InvoiceRow[]) {
      const daysOver = daysBetween(inv.due_date, now)
      const label = invoiceJobLabel(inv)
      const amount = formatCurrency(inv.amount)
      const dayWord = daysOver === 1 ? 'day' : 'days'
      alerts.push({
        priority: 'high',
        message: `${label} has an invoice for ${amount} that is ${daysOver} ${dayWord} overdue.`,
        action: 'Send payment reminder',
        entity_id: inv.id,
        entity_type: 'invoice',
      })
    }

    // ── 2. Pending variations awaiting approval ───────────────
    const { data: pendingVariations } = await supabase
      .from('variations')
      .select('id, title, amount, status, created_at, job:jobs(address)')
      .eq('builder_id', builder_id)
      .eq('status', 'pending')

    for (const v of (pendingVariations ?? []) as unknown as VariationRow[]) {
      const daysWaiting = daysBetween(v.created_at, now)
      const jobAddr = v.job?.address
        ? `the job at ${v.job.address.split(',')[0]?.trim()}`
        : 'a job'
      const amountStr = v.amount ? ` for ${formatCurrency(v.amount)}` : ''
      const dayWord = daysWaiting === 1 ? 'day' : 'days'
      alerts.push({
        priority: 'high',
        message: `Variation "${v.title}"${amountStr} on ${jobAddr} has been awaiting client approval for ${daysWaiting} ${dayWord}.`,
        action: 'Chase client approval',
        entity_id: v.id,
        entity_type: 'variation',
      })
    }

    // ── 3. Quotes sent > 7 days ago with no response ──────────
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: staleSentQuotes } = await supabase
      .from('quotes')
      .select('id, status, sent_at, job:jobs(address, client:clients(name))')
      .eq('builder_id', builder_id)
      .eq('status', 'sent')
      .lt('sent_at', sevenDaysAgo)

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
        action: 'Follow up with client',
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
      .lt('updated_at', fiveDaysAgo)

    for (const j of (staleJobs ?? []) as unknown as JobRow[]) {
      const daysStale = daysBetween(j.updated_at, now)
      const label = jobLabel(j)
      const dayWord = daysStale === 1 ? 'day' : 'days'
      alerts.push({
        priority: 'medium',
        message: `${label.charAt(0).toUpperCase() + label.slice(1)} has had no updates for ${daysStale} ${dayWord}.`,
        action: 'Log progress update',
        entity_id: j.id,
        entity_type: 'job',
      })
    }

    // ── 5. Summary: active job count ─────────────────────────
    const { count: activeJobCount } = await supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('builder_id', builder_id)
      .eq('status', 'active')

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
      .eq('status', 'quoting')

    if ((quotingCount ?? 0) > 0) {
      const jobWord = quotingCount === 1 ? 'job' : 'jobs'
      alerts.push({
        priority: 'low',
        message: `${quotingCount} ${jobWord} in the quoting pipeline.`,
        entity_type: 'summary',
      })
    }

    // ── Build brief summary string ────────────────────────────
    const highCount = alerts.filter((a) => a.priority === 'high').length
    const mediumCount = alerts.filter((a) => a.priority === 'medium').length

    let brief: string
    if (alerts.length === 0) {
      brief = 'All clear — no urgent items today. Have a great day on site.'
    } else if (highCount === 0 && mediumCount === 0) {
      brief = `No urgent items today. ${alerts.length} low-priority update${alerts.length > 1 ? 's' : ''} for your attention.`
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
