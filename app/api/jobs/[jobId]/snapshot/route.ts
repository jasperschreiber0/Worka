import { NextRequest, NextResponse } from 'next/server'
import { getDemoJobSnapshot } from '@/lib/job-snapshot-demo'
import { createClient } from '@supabase/supabase-js'
import type { JobSnapshot } from '@/lib/job-snapshot-demo'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysAgo(dateStr: string): string {
  const d = new Date(dateStr)
  const diffMs = Date.now() - d.getTime()
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

// ─── GET /api/jobs/[jobId]/snapshot ──────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const { jobId } = params

  // ── Demo mode ─────────────────────────────────────────────────────────────
  const isDemoMode =
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL === 'your-supabase-url'

  if (isDemoMode) {
    const snapshot = getDemoJobSnapshot(jobId)
    if (!snapshot) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }
    return NextResponse.json({ snapshot })
  }

  // ── Real mode: query Supabase ─────────────────────────────────────────────
  // Use untyped client — activation tables (invoice_schedule, job_workers) are
  // not yet reflected in database.types.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } }) as any

  // Job + client
  const { data: job, error: jobErr } = await sb
    .from('jobs')
    .select('*, clients(name, email, phone)')
    .eq('id', jobId)
    .single()

  if (jobErr || !job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  // Quote
  const { data: quotes } = await sb
    .from('quotes')
    .select('*')
    .eq('job_id', jobId)
    .order('version', { ascending: false })
    .limit(1)

  const quote = quotes?.[0] ?? null

  // Unresolved assumptions count
  let unresolvedCount = 0
  if (quote) {
    const { count } = await sb
      .from('quote_line_items')
      .select('id', { count: 'exact', head: true })
      .eq('quote_id', quote.id)
      .eq('is_assumption', true)
      .eq('assumption_status', 'unresolved')
    unresolvedCount = count ?? 0
  }

  // Variations
  const { data: variations } = await sb
    .from('variations')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })

  // Invoice schedule (activation-generated)
  const { data: invoiceSchedule } = await sb
    .from('invoice_schedule')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true })

  // Files
  const { data: files } = await sb
    .from('files')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })

  // Communications
  const { data: comms } = await sb
    .from('communication_history')
    .select('*')
    .eq('job_id', jobId)
    .order('timestamp', { ascending: false })
    .limit(50)

  // Workers on job
  const { data: jobWorkers } = await sb
    .from('job_workers')
    .select('workers(name, role)')
    .eq('job_id', jobId)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workersOnJob = (jobWorkers ?? []).map((jw: any) =>
    jw.workers ? `${jw.workers.name} (${jw.workers.role})` : null
  ).filter(Boolean) as string[]

  // Last activity: most recent of comms, files, or job.updated_at
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const timestamps = [job.updated_at, ...(comms ?? []).map((c: any) => c.timestamp), ...(files ?? []).map((f: any) => f.created_at)].filter(Boolean)
  timestamps.sort((a: string, b: string) => new Date(b).getTime() - new Date(a).getTime())
  const lastActivity = timestamps[0] ? daysAgo(timestamps[0]) : 'No activity yet'

  // ── Risk engine (deterministic, no AI) ───────────────────────────────────
  const risks: JobSnapshot['risks'] = []
  const now = Date.now()

  if (job.quote_deadline) {
    const deadline = new Date(job.quote_deadline).getTime()
    const hoursLeft = (deadline - now) / (1000 * 60 * 60)
    if (hoursLeft < 0) {
      risks.push({ level: 'high', message: `Quote deadline passed ${Math.abs(Math.round(hoursLeft / 24))} day(s) ago.` })
    } else if (hoursLeft <= 48 && !quote) {
      risks.push({ level: 'high', message: `Quote needed in ${Math.round(hoursLeft)}h — no draft exists yet.` })
    } else if (hoursLeft <= 48 && quote && unresolvedCount > 0) {
      risks.push({ level: 'high', message: `Quote due in ${Math.round(hoursLeft)}h — ${unresolvedCount} assumption${unresolvedCount > 1 ? 's' : ''} still unresolved.` })
    } else if (hoursLeft <= 96) {
      risks.push({ level: 'medium', message: `Quote deadline in ${Math.round(hoursLeft / 24)} day(s).` })
    }
  }

  if (quote && unresolvedCount > 0) {
    risks.push({ level: 'high', message: `${unresolvedCount} assumption${unresolvedCount > 1 ? 's' : ''} unresolved — quote cannot advance to pending review.` })
  }

  const typedFiles = (files ?? []) as Array<{ intake_status: string }>
  const unprocessed = typedFiles.filter(f => f.intake_status === 'uploaded' || f.intake_status === 'failed')
  if (unprocessed.length > 0) {
    risks.push({ level: 'medium', message: `${unprocessed.length} plan${unprocessed.length > 1 ? 's' : ''} uploaded but not yet processed.` })
  }

  if (job.budget_estimate && typedFiles.length === 0) {
    risks.push({ level: 'medium', message: 'Budget noted but no plans uploaded — quote cannot be generated.' })
  }

  if (!quote && !job.budget_estimate && typedFiles.length === 0) {
    risks.push({ level: 'medium', message: 'No plans, no budget, no quote — upload plans to start.' })
  }

  if (!job.clients?.email) {
    risks.push({ level: 'low', message: 'Client email missing — required to send quote.' })
  }

  const snapshot: JobSnapshot = {
    job: {
      id: job.id,
      address: job.address,
      status: job.status,
      job_type: job.job_type ?? null,
      client_name: job.clients?.name ?? null,
      client_email: job.clients?.email ?? null,
      client_phone: job.clients?.phone ?? null,
      created_at: daysAgo(job.created_at),
      days_active: Math.floor((Date.now() - new Date(job.created_at).getTime()) / (1000 * 60 * 60 * 24)),
      budget_estimate: job.budget_estimate ?? null,
      scope_notes: job.scope_notes ?? null,
      quote_deadline: job.quote_deadline ?? null,
      client_deadline: job.client_deadline ?? null,
    },
    overview: {
      started: daysAgo(job.created_at),
      workers_on_job: workersOnJob,
      last_activity: lastActivity,
      notes: job.notes ?? null,
      margin_to_date: null,
      spend_to_date: null,
    },
    quote: quote
      ? {
          id: quote.id,
          status: quote.status,
          total_cost: quote.total_cost ?? null,
          confidence_score: quote.confidence_score ?? null,
          sent_at: quote.sent_at ? daysAgo(quote.sent_at) : null,
          version: quote.version,
          unresolved_count: unresolvedCount,
        }
      : null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    variations: (variations ?? []).map((v: any) => ({
      id: v.id,
      title: v.title,
      amount: v.amount ?? 0,
      status: v.status,
      created_at: daysAgo(v.created_at),
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    invoices: (invoiceSchedule ?? []).map((inv: any) => ({
      id: inv.id,
      amount: inv.amount,
      status: inv.invoice_id ? 'sent' : 'draft',
      due_date: inv.due_trigger,
      sent_at: null,
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    files: (files ?? []).map((f: any) => ({
      id: f.id,
      filename: f.filename,
      file_type: f.file_type,
      intake_status: f.intake_status,
      uploaded_at: daysAgo(f.created_at),
    })),
    comms: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: (comms ?? []).map((c: any) => ({
        id: c.id,
        direction: c.direction,
        channel: c.channel,
        subject: c.subject ?? null,
        preview: c.body.slice(0, 120),
        timestamp: daysAgo(c.timestamp),
      })),
    },
    risks,
  }

  return NextResponse.json({ snapshot })
}
