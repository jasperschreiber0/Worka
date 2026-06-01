'use client'

import { useState, useRef, useEffect } from 'react'

export interface WorkerListItem {
  id: string
  name: string
  role: string
  status: 'invited' | 'active' | 'inactive'
  email: string | null
  phone: string | null
}

interface JobOption {
  id: string
  address: string
  status: string
}

interface WorkerListCardProps {
  workers: WorkerListItem[]
  builderId: string
  onAssignTask?: (workerName: string) => void
  onWorkerUpdated?: (worker: WorkerListItem) => void
  onWorkerRemoved?: (workerId: string) => void
}

function statusPill(status: string) {
  if (status === 'active') return 'bg-green-100 text-green-700'
  if (status === 'invited') return 'bg-amber-100 text-amber-700'
  return 'bg-slate-100 text-slate-500'
}

function WorkerRow({
  worker,
  builderId,
  onAssignTask,
  onUpdated,
  onRemoved,
}: {
  worker: WorkerListItem
  builderId: string
  onAssignTask?: (name: string) => void
  onUpdated?: (w: WorkerListItem) => void
  onRemoved?: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState(worker.name)
  const [role, setRole] = useState(worker.role)
  const [email, setEmail] = useState(worker.email ?? '')
  const [phone, setPhone] = useState(worker.phone ?? '')

  // Add to job
  const [jobPickerOpen, setJobPickerOpen] = useState(false)
  const [jobs, setJobs] = useState<JobOption[]>([])
  const [jobsLoading, setJobsLoading] = useState(false)
  const [assigningJobId, setAssigningJobId] = useState<string | null>(null)
  const [assignedJobIds, setAssignedJobIds] = useState<Set<string>>(new Set())
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!jobPickerOpen) return
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setJobPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [jobPickerOpen])

  async function openJobPicker() {
    setJobPickerOpen(true)
    if (jobs.length > 0) return
    setJobsLoading(true)
    try {
      const res = await fetch(`/api/jobs?builder_id=${builderId}`)
      if (res.ok) {
        const data = await res.json() as { jobs: JobOption[] }
        setJobs(data.jobs)
      }
    } finally {
      setJobsLoading(false)
    }
  }

  async function assignToJob(jobId: string) {
    setAssigningJobId(jobId)
    try {
      const res = await fetch(`/api/jobs/${jobId}/workers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worker_id: worker.id, builder_id: builderId }),
      })
      if (res.ok || res.status === 409) {
        setAssignedJobIds((prev) => { const next = new Set(Array.from(prev)); next.add(jobId); return next })
      }
    } finally {
      setAssigningJobId(null)
      setJobPickerOpen(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch(`/api/workers/${worker.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builder_id: builderId, name: name.trim(), role: role.trim(), email: email.trim() || null, phone: phone.trim() || null }),
      })
      if (res.ok) {
        const data = await res.json() as { worker: WorkerListItem }
        onUpdated?.({ ...worker, ...data.worker, name: name.trim(), role: role.trim(), email: email.trim() || null, phone: phone.trim() || null })
        setEditing(false)
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleDeactivate() {
    if (!confirm(`Remove ${worker.name} from your crew?`)) return
    const res = await fetch(`/api/workers/${worker.id}?builder_id=${builderId}`, { method: 'DELETE' })
    if (res.ok) onRemoved?.(worker.id)
  }

  if (editing) {
    return (
      <div className="px-3 py-3 bg-slate-50 border-b border-slate-100 last:border-b-0">
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-slate-500 mb-0.5">Name</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-0.5">Trade / Role</label>
              <input
                value={role}
                onChange={e => setRole(e.target.value)}
                className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-slate-500 mb-0.5">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="optional"
                className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-0.5">Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="optional"
                className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !name.trim() || !role.trim()}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand-500 text-white disabled:opacity-50 hover:bg-brand-600 transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDeactivate}
              className="ml-auto px-3 py-1.5 text-xs font-medium rounded-md text-red-600 hover:bg-red-50 transition-colors"
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <div className="flex items-center px-3 py-2.5 min-h-[52px]">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-900 truncate">{worker.name}</p>
          <p className="text-xs text-slate-500 capitalize">{worker.role}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${statusPill(worker.status)}`}>
            {worker.status}
          </span>
          {/* Add to job */}
          <div className="relative" ref={pickerRef}>
            <button
              type="button"
              onClick={() => void openJobPicker()}
              title="Add to job"
              className="w-7 h-7 flex items-center justify-center rounded-md text-slate-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
              </svg>
            </button>
            {jobPickerOpen && (
              <div className="absolute right-0 top-8 z-20 w-56 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden">
                <div className="px-3 py-2 border-b border-slate-100 bg-slate-50">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Add to job</p>
                </div>
                {jobsLoading ? (
                  <div className="px-3 py-3 text-xs text-slate-400">Loading jobs…</div>
                ) : jobs.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-slate-400">No active jobs found.</div>
                ) : (
                  <ul>
                    {jobs.map((job) => {
                      const done = assignedJobIds.has(job.id)
                      return (
                        <li key={job.id}>
                          <button
                            type="button"
                            onClick={() => !done && void assignToJob(job.id)}
                            disabled={assigningJobId === job.id || done}
                            className={`w-full text-left px-3 py-2.5 flex items-center gap-2 transition-colors text-sm ${
                              done
                                ? 'text-green-700 bg-green-50 cursor-default'
                                : 'text-slate-700 hover:bg-slate-50'
                            }`}
                          >
                            {done ? (
                              <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                              </svg>
                            ) : assigningJobId === job.id ? (
                              <span className="w-4 h-4 flex-shrink-0 text-slate-400 text-xs">…</span>
                            ) : (
                              <span className="w-4 h-4 flex-shrink-0" />
                            )}
                            <span className="truncate leading-snug">{job.address.split(',')[0]}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
          {onAssignTask && (
            <button
              type="button"
              onClick={() => onAssignTask(worker.name.split(' ')[0])}
              title="Assign task"
              className="w-7 h-7 flex items-center justify-center rounded-md text-slate-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 0 2-2h2a2 2 0 0 0 2 2m-6 9 2 2 4-4" />
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="Edit worker"
            className="w-7 h-7 flex items-center justify-center rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

export default function WorkerListCard({ workers: initialWorkers, builderId, onAssignTask, onWorkerUpdated, onWorkerRemoved }: WorkerListCardProps) {
  const [workers, setWorkers] = useState(initialWorkers)

  function handleUpdated(updated: WorkerListItem) {
    setWorkers(prev => prev.map(w => w.id === updated.id ? { ...w, ...updated } : w))
    onWorkerUpdated?.(updated)
  }

  function handleRemoved(id: string) {
    setWorkers(prev => prev.filter(w => w.id !== id))
    onWorkerRemoved?.(id)
  }

  if (workers.length === 0) {
    return (
      <div className="mt-2 rounded-xl border border-slate-200 bg-white shadow-sm px-4 py-3 text-sm text-slate-500">
        No active workers on your crew.
      </div>
    )
  }

  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-3 py-2 border-b border-slate-100 bg-slate-50">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Your crew ({workers.length})</p>
      </div>
      {workers.map(worker => (
        <WorkerRow
          key={worker.id}
          worker={worker}
          builderId={builderId}
          onAssignTask={onAssignTask}
          onUpdated={handleUpdated}
          onRemoved={handleRemoved}
        />
      ))}
    </div>
  )
}
