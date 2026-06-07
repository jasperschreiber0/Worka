import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServerComponentClient } from '@supabase/auth-helpers-nextjs'

export interface DashboardAlert {
  id: string
  priority: 'high' | 'medium' | 'low'
  message: string
  action?: string
  entity_id?: string
  entity_type?: 'job' | 'invoice' | 'variation' | 'quote'
}

export interface DashboardRecommendation {
  id: string
  type: 'margin' | 'cost' | 'compliance' | 'opportunity'
  message: string
  detail: string
}

export interface DashboardActivity {
  id: string
  type: 'upload' | 'quote' | 'variation' | 'invoice' | 'email' | 'task' | 'job'
  description: string
  job_address?: string
  timestamp: string
}

export interface DashboardStats {
  active_jobs: number
  pending_variations: number
  overdue_invoices: number
}

export interface DashboardData {
  stats: DashboardStats
  alerts: DashboardAlert[]
  recommendations: DashboardRecommendation[]
  activity: DashboardActivity[]
  demo?: boolean
}

const DEMO_DATA: DashboardData = {
  stats: { active_jobs: 3, pending_variations: 2, overdue_invoices: 1 },
  alerts: [
    {
      id: 'a1',
      priority: 'high',
      message: 'Invoice for $28,000 on the Fitzroy job (14 Merri St) is 3 days overdue. The Hendersons have not paid.',
      action: 'Chase payment',
      entity_id: '00000000-0000-0000-0000-000000000061',
      entity_type: 'invoice',
    },
    {
      id: 'a2',
      priority: 'high',
      message: '2 variations on the Fitzroy job waiting for approval — kitchen benchtop ($3,200) and extra GPO points ($680).',
      action: 'Review variations',
      entity_id: '00000000-0000-0000-0000-000000000010',
      entity_type: 'job',
    },
    {
      id: 'a3',
      priority: 'medium',
      message: 'Toorak quote for $127,500 sent to Tom Caruso 5 days ago — no response yet.',
      action: 'Follow up',
      entity_id: '00000000-0000-0000-0000-000000000041',
      entity_type: 'quote',
    },
    {
      id: 'a4',
      priority: 'low',
      message: '52 Bendigo St, Brunswick — in quoting, no quote sent yet.',
      action: 'Open job',
      entity_id: '00000000-0000-0000-0000-000000000030',
      entity_type: 'job',
    },
  ],
  recommendations: [
    {
      id: 'r1',
      type: 'cost',
      message: 'Timber framing costs up 7% since Fitzroy quote',
      detail: 'Platform rates moved from $42/lm to $45/lm. The original quote may be under-costed by ~$1,800.',
    },
    {
      id: 'r2',
      type: 'margin',
      message: 'Brunswick variation may reduce margin by $2,400',
      detail: 'The deck extension adds scope without a rate adjustment. Consider raising the variation amount.',
    },
    {
      id: 'r3',
      type: 'opportunity',
      message: 'Progress claim for Fitzroy is ready to send',
      detail: 'Milestone 3 (framing complete) was signed off 4 days ago. $28,000 can be claimed now.',
    },
    {
      id: 'r4',
      type: 'compliance',
      message: 'Waterproofing certificate missing from Toorak job',
      detail: 'Required before tiling can begin. Request from your plumber or waterproofing contractor.',
    },
  ],
  activity: [
    { id: 'ac1', type: 'upload', description: 'Plans uploaded', job_address: '52 Bendigo St, Brunswick', timestamp: new Date(Date.now() - 14 * 60 * 1000).toISOString() },
    { id: 'ac2', type: 'invoice', description: 'Receipt processed — Bunnings $184.20', job_address: '14 Merri St, Fitzroy', timestamp: new Date(Date.now() - 47 * 60 * 1000).toISOString() },
    { id: 'ac3', type: 'email', description: 'Client email received', job_address: '88 Kooyong Rd, Toorak', timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
    { id: 'ac4', type: 'quote', description: 'Quote generated — $127,500', job_address: '88 Kooyong Rd, Toorak', timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() },
    { id: 'ac5', type: 'variation', description: 'Variation approved — kitchen benchtop $3,200', job_address: '14 Merri St, Fitzroy', timestamp: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString() },
    { id: 'ac6', type: 'invoice', description: 'Invoice sent — $14,000', job_address: '14 Merri St, Fitzroy', timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
    { id: 'ac7', type: 'job', description: 'New job created', job_address: '52 Bendigo St, Brunswick', timestamp: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString() },
  ],
}

export async function GET() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return NextResponse.json({ ...DEMO_DATA, demo: true })
  }

  try {
    const supabase = createServerComponentClient({ cookies })
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const builderId = user.id

    const [{ data: jobs }, { data: invoices }, { data: variations }] = await Promise.all([
      supabase
        .from('jobs')
        .select('id, address, status, client_name, updated_at')
        .eq('builder_id', builderId)
        .not('status', 'in', '("archived")')
        .order('updated_at', { ascending: false })
        .limit(20),
      supabase
        .from('invoice_schedule')
        .select('id, job_id, amount, due_date, status')
        .eq('builder_id', builderId)
        .eq('status', 'sent')
        .lt('due_date', new Date().toISOString().split('T')[0]),
      supabase
        .from('variations')
        .select('id, job_id, title, amount, status')
        .eq('builder_id', builderId)
        .eq('status', 'pending'),
    ])

    const activeJobs = (jobs ?? []).filter(j => j.status === 'active')
    const quotingJobs = (jobs ?? []).filter(j => j.status === 'quoting' || j.status === 'quoted')
    const overdueInvoices = invoices ?? []
    const pendingVariations = variations ?? []

    const alerts: DashboardAlert[] = []

    for (const inv of overdueInvoices.slice(0, 2)) {
      const job = (jobs ?? []).find(j => j.id === inv.job_id)
      const addr = job?.address?.split(',')[0] ?? 'Unknown job'
      alerts.push({
        id: `inv-${inv.id}`,
        priority: 'high',
        message: `Invoice for $${Number(inv.amount).toLocaleString()} on ${addr} is overdue.`,
        action: 'Chase payment',
        entity_id: inv.id,
        entity_type: 'invoice',
      })
    }

    const varByJob = new Map<string, typeof pendingVariations>()
    for (const v of pendingVariations) {
      if (!varByJob.has(v.job_id)) varByJob.set(v.job_id, [])
      varByJob.get(v.job_id)!.push(v)
    }
    for (const [jobId, vars] of Array.from(varByJob.entries())) {
      const job = (jobs ?? []).find(j => j.id === jobId)
      const addr = job?.address?.split(',')[0] ?? 'Unknown job'
      alerts.push({
        id: `var-${jobId}`,
        priority: 'high',
        message: vars.length === 1
          ? `1 variation on ${addr} waiting for approval — ${vars[0].title}.`
          : `${vars.length} variations on ${addr} waiting for approval.`,
        action: 'Review variations',
        entity_id: jobId,
        entity_type: 'job',
      })
    }

    for (const job of quotingJobs.slice(0, 3)) {
      alerts.push({
        id: `job-${job.id}`,
        priority: 'low',
        message: `${job.address?.split(',')[0]} — in quoting, no quote sent yet.`,
        action: 'Open job',
        entity_id: job.id,
        entity_type: 'job',
      })
    }

    const activity: DashboardActivity[] = (jobs ?? []).slice(0, 7).map(job => ({
      id: `job-${job.id}`,
      type: 'job' as const,
      description: job.status === 'active' ? 'Job activated' : `Job updated`,
      job_address: job.address,
      timestamp: job.updated_at,
    }))

    return NextResponse.json({
      stats: {
        active_jobs: activeJobs.length,
        pending_variations: pendingVariations.length,
        overdue_invoices: overdueInvoices.length,
      },
      alerts,
      recommendations: DEMO_DATA.recommendations,
      activity,
    } satisfies DashboardData)
  } catch (err) {
    console.error('[dashboard]', err)
    return NextResponse.json(DEMO_DATA)
  }
}
