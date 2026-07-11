// ─── Real worker-portal data resolution ───────────────────────────────────────
// Resolves the worka_worker_session cookie into the specific worker's real
// jobs/milestones/tasks, instead of the portal always rendering the
// hardcoded DEMO_WORKER_JACK to anyone who requested the page.

import { createClient } from '@supabase/supabase-js'
import { isDemoMode } from '@/lib/auth/api-auth'
import { hashWorkerSessionToken, isWorkerSessionExpired } from '@/lib/auth/worker-session'
import { DEMO_WORKER_JACK, type DemoWorker, type DemoWorkerJob } from '@/lib/worker-demo'

const DEMO_WORKERS_BY_ID: Record<string, DemoWorker> = {
  'w-jack-001': DEMO_WORKER_JACK,
  // Mick has no seeded portal data of his own — fall back to Jack's shape
  // rather than a broken/empty screen.
  'w-mick-002': { ...DEMO_WORKER_JACK, id: 'w-mick-002', name: 'Mick Reynolds', role: 'Plumber', initials: 'MR' },
}

/** Splits a single-string address into "street" / "suburb" halves for display, best-effort. */
function splitAddress(address: string): { street: string; suburb: string } {
  const commaIndex = address.indexOf(',')
  if (commaIndex === -1) return { street: address, suburb: '' }
  return { street: address.slice(0, commaIndex).trim(), suburb: address.slice(commaIndex + 1).trim() }
}

function urgencyFromDueDate(dueDate: string | null): DemoWorkerJob['milestone_due_urgency'] {
  if (!dueDate) return 'ok'
  const days = Math.ceil((new Date(dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  if (days < 0) return 'overdue'
  if (days <= 5) return 'soon'
  return 'ok'
}

function dueDisplayFromDueDate(dueDate: string | null): string {
  if (!dueDate) return ''
  const days = Math.ceil((new Date(dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) !== 1 ? 's' : ''} overdue`
  if (days === 0) return 'Due today'
  return `Due in ${days} day${days !== 1 ? 's' : ''}`
}

/**
 * Resolves the worka_worker_session cookie value into that specific
 * worker's real data. Returns null when there's no session, an expired
 * one, or (in real mode) it doesn't match any worker — callers should
 * prompt the visitor to use their invite link rather than falling back to
 * demo data, since that's exactly the bug this replaces.
 */
export async function resolveWorkerPortalData(cookieValue: string | undefined): Promise<DemoWorker | null> {
  if (!cookieValue) return null

  if (isDemoMode()) {
    if (!cookieValue.startsWith('demo:')) return null
    const workerId = cookieValue.slice('demo:'.length)
    return DEMO_WORKERS_BY_ID[workerId] ?? null
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) return null

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  const tokenHash = hashWorkerSessionToken(cookieValue)

  const { data: worker } = await supabase
    .from('workers')
    .select('id, name, role, builder_id, session_token_hash, session_token_expires_at')
    .eq('session_token_hash', tokenHash)
    .single()

  if (!worker || isWorkerSessionExpired(worker.session_token_expires_at)) return null

  const [{ data: builder }, { data: jobWorkers }] = await Promise.all([
    supabase.from('builders').select('name, business_name').eq('id', worker.builder_id).maybeSingle(),
    supabase
      .from('job_workers')
      .select('jobs ( id, address, status, job_ref )')
      .eq('worker_id', worker.id)
      .order('assigned_at', { ascending: false }),
  ])

  type JobRow = { id: string; address: string; status: string; job_ref: string | null }
  const jobRows = ((jobWorkers ?? []) as unknown as Array<{ jobs: JobRow | null }>)
    .map((jw) => jw.jobs)
    .filter((j): j is JobRow => j !== null && j.status !== 'archived' && j.status !== 'complete')

  const jobs: DemoWorkerJob[] = await Promise.all(
    jobRows.map(async (jobRow) => {
      const { street, suburb } = splitAddress(jobRow.address)

      const [{ data: milestones }, { data: tasks }] = await Promise.all([
        supabase
          .from('job_milestones')
          .select('title, due_date')
          .eq('job_id', jobRow.id)
          .is('completed_at', null)
          .order('sort_order', { ascending: true })
          .limit(1),
        supabase
          .from('job_tasks')
          .select('description, status')
          .eq('job_id', jobRow.id)
          .eq('assigned_worker_id', worker.id)
          .order('created_at', { ascending: false }),
      ])

      const nextMilestone = (milestones ?? [])[0] as { title: string; due_date: string | null } | undefined

      return {
        id: jobRow.id,
        ref: jobRow.job_ref ?? '',
        address: street,
        suburb,
        status: jobRow.status,
        start_time: '',
        milestone_label: nextMilestone?.title ?? '',
        milestone_week: '',
        milestone_due_display: dueDisplayFromDueDate(nextMilestone?.due_date ?? null),
        milestone_due_urgency: urgencyFromDueDate(nextMilestone?.due_date ?? null),
        builder_name: builder?.name ?? 'Your builder',
        builder_phone: '',
        site_supervisor: builder?.name ?? '',
        tasks: ((tasks ?? []) as Array<{ description: string; status: string }>).map((t) => ({
          label: t.description,
          done: t.status === 'done',
        })),
      }
    })
  )

  const initials = worker.name
    .split(' ')
    .map((p: string) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return {
    id: worker.id,
    name: worker.name,
    role: worker.role,
    initials: initials || '?',
    builder_name: builder?.name ?? 'Your builder',
    builder_company: builder?.business_name ?? '',
    jobs,
  }
}
