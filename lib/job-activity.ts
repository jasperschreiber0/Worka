// Shared "last activity" computation — most recent of comms, files, or the
// job's own updated_at. Originally lived only in the per-job snapshot route;
// extracted so the dashboard feed can compute it for N jobs in two batched
// queries instead of N.

import type { SupabaseClient } from '@supabase/supabase-js'

export function daysAgo(dateStr: string): string {
  const d = new Date(dateStr)
  const diffMs = Date.now() - d.getTime()
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

export async function computeLastActivityByJob(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: SupabaseClient<any>,
  jobs: Array<{ id: string; updated_at: string }>
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const jobIds = jobs.map(j => j.id)
  if (jobIds.length === 0) return result

  const [{ data: comms }, { data: files }] = await Promise.all([
    sb.from('communication_history').select('job_id, timestamp').in('job_id', jobIds),
    sb.from('files').select('job_id, created_at').in('job_id', jobIds),
  ])

  const latestMsByJob = new Map<string, number>()
  for (const j of jobs) latestMsByJob.set(j.id, new Date(j.updated_at).getTime())

  for (const c of (comms ?? []) as Array<{ job_id: string; timestamp: string }>) {
    const t = new Date(c.timestamp).getTime()
    if (t > (latestMsByJob.get(c.job_id) ?? 0)) latestMsByJob.set(c.job_id, t)
  }
  for (const f of (files ?? []) as Array<{ job_id: string; created_at: string }>) {
    const t = new Date(f.created_at).getTime()
    if (t > (latestMsByJob.get(f.job_id) ?? 0)) latestMsByJob.set(f.job_id, t)
  }

  Array.from(latestMsByJob.entries()).forEach(([jobId, ts]) => {
    result.set(jobId, daysAgo(new Date(ts).toISOString()))
  })
  return result
}
