import type { Metadata } from 'next'
import { createClient } from '@supabase/supabase-js'
import { getDemoInvite, type DemoWorkerInvite } from '@/lib/worker-demo'
import { isDemoMode } from '@/lib/auth/api-auth'
import JoinFlow from './JoinFlow'

interface JoinPageProps {
  params: Promise<{ token: string }>
}

export const metadata: Metadata = {
  title: 'Join WorkA',
  description: "You've been invited to join a WorkA crew.",
}

async function loadRealInvite(token: string): Promise<DemoWorkerInvite | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) return null

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

  const { data: worker } = await supabase
    .from('workers')
    .select('id, name, role, builder_id')
    .eq('invite_token', token)
    .single()

  if (!worker) return null

  const [{ data: builder }, { data: jobWorker }] = await Promise.all([
    supabase.from('builders').select('name, business_name').eq('id', worker.builder_id).maybeSingle(),
    supabase
      .from('job_workers')
      .select('jobs ( address, job_ref )')
      .eq('worker_id', worker.id)
      .order('assigned_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const job = (jobWorker as { jobs: { address: string; job_ref: string | null } | null } | null)?.jobs ?? null

  return {
    token,
    worker_id: worker.id,
    worker_name: worker.name,
    role: worker.role,
    builder_name: builder?.name ?? 'Your builder',
    builder_company: builder?.business_name ?? '',
    builder_phone: '',
    job_address: job?.address ?? '',
    job_ref: job?.job_ref ?? '',
  }
}

export default async function JoinPage({ params }: JoinPageProps) {
  const { token } = await params

  // Live mode: look up the invite token in the workers table.
  // Demo mode: return a pre-seeded invite so the flow works without Supabase.
  const invite = isDemoMode() ? getDemoInvite(token) : await loadRealInvite(token)

  if (!invite) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6 text-center">
        <p className="text-xl font-bold text-slate-900 mb-2">Invalid invite link</p>
        <p className="text-sm text-slate-500">
          This invite link is invalid or has expired. Ask your builder to send a new one.
        </p>
      </div>
    )
  }

  return <JoinFlow invite={invite} />
}
