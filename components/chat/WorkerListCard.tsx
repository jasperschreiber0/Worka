'use client'

import { useState, useRef, useEffect, useCallback } from 'react'

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

interface ParsedTask {
  text: string
  key: string
}

interface WorkerListCardProps {
  workers: WorkerListItem[]
  builderId: string
  onAssignTask?: (workerName: string) => void
  onWorkerUpdated?: (worker: WorkerListItem) => void
  onWorkerRemoved?: (workerId: string) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusPillStyle(status: string): React.CSSProperties {
  if (status === 'active') return { backgroundColor: 'rgba(76,175,80,0.12)', color: 'var(--status-green)' }
  if (status === 'invited') return { backgroundColor: 'var(--pill-awaiting-bg)', color: 'var(--pill-awaiting-text)' }
  return { backgroundColor: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }
}

function parseTasks(raw: string): ParsedTask[] {
  // Split on commas or newlines, trim, dedupe, filter blanks
  return raw
    .split(/[\n,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((text, i) => ({ text, key: `${i}-${text}` }))
}

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  fontSize: 13,
  padding: '6px 10px',
  borderRadius: 4,
  border: '0.5px solid var(--bg-border)',
  backgroundColor: 'var(--bg-shell)',
  color: 'var(--text-primary)',
  outline: 'none',
}

const LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  color: 'var(--text-tertiary)',
  marginBottom: 4,
}

// ─── Inline task assignment panel ─────────────────────────────────────────────

function TaskPanel({
  worker,
  builderId,
  onDone,
}: {
  worker: WorkerListItem
  builderId: string
  onDone: () => void
}) {
  const [jobs, setJobs] = useState<JobOption[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [selectedJobId, setSelectedJobId] = useState<string>('')
  const [rawText, setRawText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState<number | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const parsed = parseTasks(rawText)
  const selectedJob = jobs.find((j) => j.id === selectedJobId)

  useEffect(() => {
    fetch(`/api/jobs?builder_id=${builderId}`)
      .then((r) => r.ok ? r.json() : { jobs: [] })
      .then((data: { jobs: JobOption[] }) => {
        setJobs(data.jobs)
        if (data.jobs.length > 0) setSelectedJobId(data.jobs[0].id)
      })
      .catch(() => {})
      .finally(() => setJobsLoading(false))
  }, [builderId])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!selectedJobId || parsed.length === 0 || submitting) return
    setSubmitting(true)
    try {
      await Promise.all(
        parsed.map((task) =>
          fetch(`/api/jobs/${selectedJobId}/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              description: task.text,
              assigned_to: worker.name,
              assigned_worker_id: worker.id,
              builder_id: builderId,
            }),
          })
        )
      )
      setSuccess(parsed.length)
      setTimeout(() => { onDone() }, 1400)
    } catch {
      setSubmitting(false)
    }
  }, [selectedJobId, parsed, submitting, worker, builderId, onDone])

  if (success !== null) {
    return (
      <div
        className="animate-slide-up"
        style={{
          padding: '12px 14px',
          backgroundColor: 'rgba(76,175,80,0.08)',
          borderTop: '0.5px solid var(--bg-border)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2.5 8L6 11.5L13.5 4" stroke="#4caf50" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{ fontSize: 13, color: 'var(--status-green)', fontWeight: 500 }}>
          {success} task{success !== 1 ? 's' : ''} added for {worker.name.split(' ')[0]}
          {selectedJob ? ` — ${selectedJob.address.split(',')[0]}` : ''}
        </span>
      </div>
    )
  }

  return (
    <div
      className="animate-slide-up"
      style={{
        padding: '12px 14px',
        borderTop: '0.5px solid var(--bg-border)',
        backgroundColor: 'var(--bg-elevated)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
          Assign tasks — {worker.name.split(' ')[0]}
        </p>
        <button
          type="button"
          onClick={onDone}
          style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 2, lineHeight: 1 }}
          aria-label="Close"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Job picker */}
      <div style={{ marginBottom: 10 }}>
        <label style={LABEL_STYLE}>Job site</label>
        {jobsLoading ? (
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Loading jobs…</p>
        ) : jobs.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No active jobs.</p>
        ) : (
          <select
            value={selectedJobId}
            onChange={(e) => setSelectedJobId(e.target.value)}
            style={{ ...INPUT_STYLE, appearance: 'none', paddingRight: 28 }}
          >
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.address.split(',')[0]}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Task input */}
      <div style={{ marginBottom: 10 }}>
        <label style={LABEL_STYLE}>
          Tasks — separate by comma or new line
        </label>
        <textarea
          ref={textareaRef}
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void handleSubmit()
            }
          }}
          placeholder={`e.g. finish framing, clean site, fix fence`}
          rows={3}
          style={{
            ...INPUT_STYLE,
            resize: 'none',
            lineHeight: 1.5,
          }}
        />
      </div>

      {/* Parsed task preview */}
      {parsed.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <p style={{ ...LABEL_STYLE, marginBottom: 6 }}>
            WorkA sees {parsed.length} task{parsed.length !== 1 ? 's' : ''}:
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {parsed.map((task, i) => (
              <li
                key={task.key}
                className="animate-fade-in"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 8px',
                  borderRadius: 4,
                  backgroundColor: 'var(--bg-surface)',
                  border: '0.5px solid var(--bg-border)',
                }}
              >
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--orange-primary)', minWidth: 14 }}>{i + 1}</span>
                <span style={{ fontSize: 12, color: 'var(--text-primary)', flex: 1 }}>{task.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Submit */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!selectedJobId || parsed.length === 0 || submitting || jobsLoading}
          style={{
            flex: 1,
            padding: '7px 12px',
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 4,
            border: 'none',
            backgroundColor: 'var(--orange-primary)',
            color: '#fff',
            cursor: (selectedJobId && parsed.length > 0 && !submitting) ? 'pointer' : 'not-allowed',
            opacity: (!selectedJobId || parsed.length === 0 || submitting || jobsLoading) ? 0.45 : 1,
          }}
        >
          {submitting
            ? 'Adding…'
            : parsed.length > 1
            ? `Add ${parsed.length} tasks`
            : parsed.length === 1
            ? 'Add task'
            : 'Add tasks'}
        </button>
        <button
          type="button"
          onClick={onDone}
          style={{
            padding: '7px 12px',
            fontSize: 12,
            borderRadius: 4,
            border: '0.5px solid var(--bg-border)',
            backgroundColor: 'transparent',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
      <p style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 6 }}>
        ⌘↵ to submit
      </p>
    </div>
  )
}

// ─── Worker row ───────────────────────────────────────────────────────────────

function WorkerRow({
  worker,
  builderId,
  onUpdated,
  onRemoved,
}: {
  worker: WorkerListItem
  builderId: string
  onUpdated?: (w: WorkerListItem) => void
  onRemoved?: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [name, setName] = useState(worker.name)
  const [role, setRole] = useState(worker.role)
  const [email, setEmail] = useState(worker.email ?? '')
  const [phone, setPhone] = useState(worker.phone ?? '')

  const [jobPickerOpen, setJobPickerOpen] = useState(false)
  const [taskPanelOpen, setTaskPanelOpen] = useState(false)
  const [jobs, setJobs] = useState<JobOption[]>([])
  const [jobsLoading, setJobsLoading] = useState(false)
  const [assigningJobId, setAssigningJobId] = useState<string | null>(null)
  const [assignedJobIds, setAssignedJobIds] = useState<Set<string>>(new Set())
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number } | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const jobBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!jobPickerOpen) return
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      if (!pickerRef.current?.contains(target) && !jobBtnRef.current?.contains(target)) {
        setJobPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [jobPickerOpen])

  async function openJobPicker() {
    if (jobBtnRef.current) {
      const rect = jobBtnRef.current.getBoundingClientRect()
      setDropdownPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    }
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
    const res = await fetch(`/api/workers/${worker.id}?builder_id=${builderId}`, { method: 'DELETE' })
    if (res.ok) onRemoved?.(worker.id)
  }

  if (editing) {
    return (
      <div style={{ padding: '12px', borderTop: '0.5px solid var(--bg-border)', backgroundColor: 'var(--bg-elevated)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
          <div>
            <label style={LABEL_STYLE}>Name</label>
            <input value={name} onChange={e => setName(e.target.value)} style={INPUT_STYLE} />
          </div>
          <div>
            <label style={LABEL_STYLE}>Trade / Role</label>
            <input value={role} onChange={e => setRole(e.target.value)} style={INPUT_STYLE} />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
          <div>
            <label style={LABEL_STYLE}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="optional" style={{ ...INPUT_STYLE, color: email ? 'var(--text-primary)' : 'var(--text-tertiary)' }} />
          </div>
          <div>
            <label style={LABEL_STYLE}>Phone</label>
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="optional" style={{ ...INPUT_STYLE, color: phone ? 'var(--text-primary)' : 'var(--text-tertiary)' }} />
          </div>
        </div>
        {confirmingRemove ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 4, backgroundColor: 'rgba(244,67,54,0.08)', border: '0.5px solid rgba(244,67,54,0.25)' }}>
            <p style={{ fontSize: 12, color: 'var(--status-red)', flex: 1 }}>Remove {worker.name}?</p>
            <button type="button" onClick={() => void handleDeactivate()} style={{ padding: '4px 10px', fontSize: 12, fontWeight: 600, borderRadius: 4, border: 'none', backgroundColor: 'var(--status-red)', color: '#fff', cursor: 'pointer' }}>Yes, remove</button>
            <button type="button" onClick={() => setConfirmingRemove(false)} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4, border: 'none', backgroundColor: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" onClick={handleSave} disabled={saving || !name.trim() || !role.trim()} style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, borderRadius: 4, border: 'none', backgroundColor: 'var(--orange-primary)', color: '#fff', cursor: 'pointer', opacity: (saving || !name.trim() || !role.trim()) ? 0.5 : 1 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => { setEditing(false); setConfirmingRemove(false) }} style={{ padding: '5px 12px', fontSize: 12, borderRadius: 4, border: '0.5px solid var(--bg-border)', backgroundColor: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>Cancel</button>
            <button type="button" onClick={() => setConfirmingRemove(true)} style={{ marginLeft: 'auto', padding: '5px 12px', fontSize: 12, borderRadius: 4, border: 'none', backgroundColor: 'transparent', color: 'var(--status-red)', cursor: 'pointer' }}>Remove</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ borderTop: '0.5px solid var(--bg-border)' }}>
      {/* Worker row */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', minHeight: 52 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{worker.name}</p>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'capitalize' }}>{worker.role}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span className="text-xs font-medium px-2 py-0.5 rounded-full capitalize" style={statusPillStyle(worker.status)}>
            {worker.status}
          </span>

          {/* Add to job */}
          <div style={{ position: 'relative' }}>
            <button
              ref={jobBtnRef}
              type="button"
              onClick={() => void openJobPicker()}
              title="Add to job"
              style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: 'none', backgroundColor: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer' }}
              onMouseOver={(e) => { e.currentTarget.style.color = 'var(--orange-primary)'; e.currentTarget.style.backgroundColor = 'var(--orange-subtle)' }}
              onMouseOut={(e) => { e.currentTarget.style.color = 'var(--text-tertiary)'; e.currentTarget.style.backgroundColor = 'transparent' }}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
              </svg>
            </button>
            {jobPickerOpen && dropdownPos && (
              <div
                ref={pickerRef}
                style={{ position: 'fixed', top: dropdownPos.top, right: dropdownPos.right, zIndex: 50, width: 220, borderRadius: 6, border: '0.5px solid var(--bg-border)', backgroundColor: 'var(--bg-elevated)', overflow: 'hidden' }}
              >
                <div style={{ padding: '8px 12px', borderBottom: '0.5px solid var(--bg-border)' }}>
                  <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>Add to job</p>
                </div>
                {jobsLoading ? (
                  <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-tertiary)' }}>Loading jobs…</div>
                ) : jobs.length === 0 ? (
                  <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-tertiary)' }}>No active jobs found.</div>
                ) : (
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {jobs.map((job) => {
                      const done = assignedJobIds.has(job.id)
                      return (
                        <li key={job.id} style={{ borderTop: '0.5px solid var(--bg-border)' }}>
                          <button
                            type="button"
                            onClick={() => !done && void assignToJob(job.id)}
                            disabled={assigningJobId === job.id || done}
                            style={{ width: '100%', textAlign: 'left', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, border: 'none', backgroundColor: done ? 'rgba(76,175,80,0.08)' : 'transparent', color: done ? 'var(--status-green)' : 'var(--text-secondary)', cursor: done ? 'default' : 'pointer' }}
                          >
                            {done ? (
                              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true" style={{ color: 'var(--status-green)' }}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                              </svg>
                            ) : assigningJobId === job.id ? (
                              <span style={{ width: 16, fontSize: 12, color: 'var(--text-tertiary)' }}>…</span>
                            ) : (
                              <span style={{ width: 16 }} />
                            )}
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.address.split(',')[0]}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Assign tasks — opens inline panel */}
          <button
            type="button"
            onClick={() => setTaskPanelOpen((o) => !o)}
            title="Assign tasks"
            style={{
              width: 28,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 4,
              border: 'none',
              backgroundColor: taskPanelOpen ? 'var(--orange-subtle)' : 'transparent',
              color: taskPanelOpen ? 'var(--orange-primary)' : 'var(--text-tertiary)',
              cursor: 'pointer',
            }}
            onMouseOver={(e) => { if (!taskPanelOpen) { e.currentTarget.style.color = 'var(--orange-primary)'; e.currentTarget.style.backgroundColor = 'var(--orange-subtle)' } }}
            onMouseOut={(e) => { if (!taskPanelOpen) { e.currentTarget.style.color = 'var(--text-tertiary)'; e.currentTarget.style.backgroundColor = 'transparent' } }}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 0 2-2h2a2 2 0 0 0 2 2m-6 9 2 2 4-4" />
            </svg>
          </button>

          {/* Edit */}
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="Edit worker"
            style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: 'none', backgroundColor: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer' }}
            onMouseOver={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; e.currentTarget.style.backgroundColor = 'var(--bg-elevated)' }}
            onMouseOut={(e) => { e.currentTarget.style.color = 'var(--text-tertiary)'; e.currentTarget.style.backgroundColor = 'transparent' }}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
            </svg>
          </button>
        </div>
      </div>

      {/* Inline task panel */}
      {taskPanelOpen && (
        <TaskPanel
          worker={worker}
          builderId={builderId}
          onDone={() => setTaskPanelOpen(false)}
        />
      )}
    </div>
  )
}

// ─── WorkerListCard ───────────────────────────────────────────────────────────

export default function WorkerListCard({ workers: initialWorkers, builderId, onWorkerUpdated, onWorkerRemoved }: WorkerListCardProps) {
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
      <div className="mt-2 px-4 py-3 text-sm" style={{ borderRadius: 6, border: '0.5px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)', color: 'var(--text-secondary)' }}>
        No active workers on your crew.
      </div>
    )
  }

  return (
    <div className="mt-2 overflow-hidden" style={{ borderRadius: 6, border: '0.5px solid var(--bg-border)', backgroundColor: 'var(--bg-surface)' }}>
      <div style={{ padding: '8px 12px', borderBottom: '0.5px solid var(--bg-border)', backgroundColor: 'var(--bg-elevated)' }}>
        <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>
          Your crew ({workers.length})
        </p>
      </div>
      {workers.map(worker => (
        <WorkerRow
          key={worker.id}
          worker={worker}
          builderId={builderId}
          onUpdated={handleUpdated}
          onRemoved={handleRemoved}
        />
      ))}
    </div>
  )
}
