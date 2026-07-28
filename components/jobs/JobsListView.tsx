'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import NewJobDrawer from './NewJobDrawer'

interface JobListItem {
  id: string
  address: string
  status: string
}

const STATUS_LABEL: Record<string, string> = {
  quoting: 'Quoting',
  quoted: 'Quoted',
  active: 'Active',
  complete: 'Complete',
  archived: 'Archived',
}

const STATUS_ORDER = ['quoting', 'quoted', 'active', 'complete']

function StatusPill({ status }: { status: string }) {
  const color =
    status === 'active' ? 'var(--status-green)' :
    status === 'quoted' ? 'var(--status-blue)' :
    status === 'complete' ? 'var(--text-tertiary)' :
    'var(--status-amber)'
  return (
    <span
      className="text-[11px] font-medium px-2 py-0.5 rounded-full"
      style={{ color, background: `${color}22` }}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

export default function JobsListView() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [jobs, setJobs] = useState<JobListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(searchParams.get('new') === '1')

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/jobs')
      if (!res.ok) throw new Error()
      const data = await res.json()
      setJobs(data.jobs ?? [])
    } catch {
      setError("Couldn't refresh your jobs — showing your last known state.")
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setDrawerOpen(true)
      router.replace('/jobs')
    }
  }, [searchParams, router])

  function openJob(job: JobListItem) {
    router.push(`/jobs/${job.id}`)
  }

  function handleCreated(job: { id: string; address: string; status: string }) {
    setDrawerOpen(false)
    setJobs((prev) => [job, ...(prev ?? [])])
    // Matches the reference workflow: New Job -> straight into upload, no
    // extra click to find the button on the job's own page.
    router.push(`/jobs/${job.id}?upload=1`)
  }

  const grouped = STATUS_ORDER
    .map((status) => ({ status, items: (jobs ?? []).filter((j) => j.status === status) }))
    .filter((g) => g.items.length > 0)

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Jobs</h1>
        <button className="btn-primary px-4 py-2 text-sm" onClick={() => setDrawerOpen(true)}>+ New Job</button>
      </div>

      {error && (
        <div className="text-sm px-3 py-2 rounded-[6px] mb-4" style={{ background: 'var(--pill-awaiting-bg)', color: 'var(--pill-awaiting-text)' }}>{error}</div>
      )}

      {jobs === null && !error && (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 rounded-[6px] animate-pulse" style={{ background: 'var(--bg-surface)' }} />
          ))}
        </div>
      )}

      {jobs !== null && jobs.length === 0 && (
        <div className="flex flex-col items-center text-center gap-3 py-20">
          <p style={{ color: 'var(--text-secondary)' }}>Nothing on the books yet. Start your first job.</p>
          <button className="btn-primary px-4 py-2 text-sm" onClick={() => setDrawerOpen(true)}>+ New Job</button>
        </div>
      )}

      {grouped.map((group) => (
        <div key={group.status} className="mb-6">
          <div className="section-label mb-2">{STATUS_LABEL[group.status]} · {group.items.length}</div>
          <div className="flex flex-col gap-1.5">
            {group.items.map((job) => (
              <button
                key={job.id}
                onClick={() => openJob(job)}
                className="card text-left px-4 py-3 flex items-center justify-between hover:brightness-110 transition-all"
              >
                <span style={{ color: 'var(--text-primary)' }}>{job.address}</span>
                <StatusPill status={job.status} />
              </button>
            ))}
          </div>
        </div>
      ))}

      <NewJobDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onCreated={handleCreated} />
    </div>
  )
}
