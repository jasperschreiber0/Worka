'use client'

import { useState } from 'react'
import type { JobTask, JobWorkerRef } from '@/lib/job-snapshot-demo'

interface TasksTabProps {
  tasks: JobTask[]
  workers: JobWorkerRef[]
  jobId: string
  builderId?: string
}

const INPUT_STYLE: React.CSSProperties = {
  backgroundColor: 'var(--bg-elevated)',
  border: '0.5px solid var(--bg-border)',
  color: 'var(--text-primary)',
  outline: 'none',
}

export default function TasksTab({
  tasks: initialTasks,
  workers,
  jobId,
  builderId = '00000000-0000-0000-0000-000000000001',
}: TasksTabProps) {
  const [tasks, setTasks] = useState<JobTask[]>(initialTasks)
  const [showForm, setShowForm] = useState(false)
  const [description, setDescription] = useState('')
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [completing, setCompleting] = useState<string | null>(null)

  const open = tasks.filter((t) => t.status === 'open')
  const done = tasks.filter((t) => t.status === 'done')

  async function handleCreate() {
    if (!description.trim()) return
    setSaving(true)
    setSaveError(null)

    const worker = workers.find((w) => w.id === selectedWorkerId) ?? null
    const optimisticId = `optimistic-${Date.now()}`
    const optimistic: JobTask = {
      id: optimisticId,
      description: description.trim(),
      assigned_to: worker?.name ?? null,
      assigned_worker_id: worker?.id ?? null,
      status: 'open',
      created_at: 'just now',
    }
    setTasks((prev) => [optimistic, ...prev])
    setDescription('')
    setSelectedWorkerId('')
    setShowForm(false)
    setSaving(false)

    try {
      const res = await fetch(`/api/jobs/${jobId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: optimistic.description,
          assigned_to: optimistic.assigned_to,
          assigned_worker_id: optimistic.assigned_worker_id,
          builder_id: builderId,
        }),
      })
      if (res.ok) {
        const { task } = await res.json() as { task: JobTask }
        setTasks((prev) => prev.map((t) => t.id === optimisticId ? task : t))
      } else {
        setTasks((prev) => prev.filter((t) => t.id !== optimisticId))
        setSaveError("Couldn't save the task — tap to try again.")
      }
    } catch {
      setTasks((prev) => prev.filter((t) => t.id !== optimisticId))
      setSaveError("Couldn't save the task — tap to try again.")
    }
  }

  async function handleComplete(taskId: string) {
    setCompleting(taskId)
    setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status: 'done' } : t))
    setCompleting(null)
    try {
      await fetch(`/api/jobs/${jobId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete', task_id: taskId, builder_id: builderId }),
      })
    } catch { /* optimistic */ }
  }

  async function handleReopen(taskId: string) {
    setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status: 'open' } : t))
    try {
      await fetch(`/api/jobs/${jobId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reopen', task_id: taskId, builder_id: builderId }),
      })
    } catch { /* optimistic */ }
  }

  return (
    <div style={{ padding: '16px' }} className="space-y-4">

      {/* Open tasks */}
      <div>
        <p className="text-[12px] font-medium mb-2" style={{ color: 'var(--text-tertiary)' }}>
          {open.length === 0 ? 'No open tasks' : `${open.length} open task${open.length !== 1 ? 's' : ''}`}
        </p>

        {open.length > 0 && (
          <ul className="space-y-1.5">
            {open.map((task) => (
              <li key={task.id} className="flex items-start gap-2.5 rounded-[6px]"
                style={{ backgroundColor: 'var(--bg-surface)', border: '0.5px solid var(--bg-border)', padding: '10px 12px' }}>
                <button
                  type="button"
                  onClick={() => void handleComplete(task.id)}
                  disabled={completing === task.id}
                  className="flex-shrink-0 mt-0.5 w-4 h-4 rounded-full border-2 transition-colors"
                  style={{ borderColor: 'var(--bg-border)' }}
                  aria-label="Mark complete"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] leading-snug" style={{ color: 'var(--text-primary)' }}>{task.description}</p>
                  <div className="flex items-center gap-2 mt-1">
                    {task.assigned_to ? (
                      <span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                        </svg>
                        {task.assigned_to}
                      </span>
                    ) : (
                      <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>Unassigned</span>
                    )}
                    <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>· {task.created_at}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Error */}
      {saveError && (
        <button type="button" onClick={() => { setSaveError(null); setShowForm(true) }}
          className="w-full text-left px-3 py-2 rounded-[4px] text-[11px]"
          style={{ backgroundColor: 'rgba(244,67,54,0.08)', border: '0.5px solid rgba(244,67,54,0.3)', color: 'var(--status-red)' }}>
          {saveError}
        </button>
      )}

      {/* Add task / form */}
      {!showForm ? (
        <button type="button" onClick={() => setShowForm(true)}
          className="inline-flex items-center gap-1.5 text-[12px] font-medium"
          style={{ color: 'var(--orange-primary)' }}>
          Add task
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      ) : (
        <div className="space-y-2.5 rounded-[6px]"
          style={{ backgroundColor: 'var(--bg-surface)', border: '0.5px solid var(--bg-border)', padding: '12px' }}>
          <textarea
            autoFocus
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleCreate() }
              if (e.key === 'Escape') { setShowForm(false); setDescription('') }
            }}
            placeholder="What needs doing?"
            rows={2}
            className="w-full text-[12px] rounded-[4px] px-3 py-2 resize-none"
            style={{ ...INPUT_STYLE }}
          />

          <div>
            <label className="block text-[11px] font-medium mb-1" style={{ color: 'var(--text-tertiary)' }}>Assign to</label>
            {workers.length === 0 ? (
              <p className="text-[11px] italic" style={{ color: 'var(--text-tertiary)' }}>No crew assigned to this job yet.</p>
            ) : (
              <select
                value={selectedWorkerId}
                onChange={(e) => setSelectedWorkerId(e.target.value)}
                className="w-full text-[12px] rounded-[4px] px-3 py-2"
                style={INPUT_STYLE}
              >
                <option value="">Unassigned</option>
                {workers.map((w) => (
                  <option key={w.id} value={w.id}>{w.name} — {w.role}</option>
                ))}
              </select>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void handleCreate()}
              disabled={!description.trim() || saving}
              className="px-4 py-2 text-[12px] font-semibold rounded-[4px] disabled:opacity-40"
              style={{ backgroundColor: 'var(--orange-primary)', color: '#fff' }}>
              {saving ? 'Saving…' : 'Add task'}
            </button>
            <button type="button" onClick={() => { setShowForm(false); setDescription(''); setSelectedWorkerId('') }}
              className="px-4 py-2 text-[12px] font-medium rounded-[4px]"
              style={{ backgroundColor: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '0.5px solid var(--bg-border)' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Completed tasks */}
      {done.length > 0 && (
        <div className="pt-2" style={{ borderTop: '0.5px solid var(--bg-border)' }}>
          <p className="text-[10px] font-medium uppercase tracking-[0.06em] mb-2" style={{ color: 'var(--text-tertiary)' }}>
            Completed ({done.length})
          </p>
          <ul className="space-y-1.5">
            {done.map((task) => (
              <li key={task.id} className="flex items-start gap-2.5 rounded-[6px]"
                style={{ backgroundColor: 'var(--bg-elevated)', border: '0.5px solid var(--bg-border)', padding: '8px 12px', opacity: 0.7 }}>
                <span className="flex-shrink-0 mt-0.5 w-4 h-4 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: 'var(--status-green)' }}>
                  <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} style={{ color: '#fff' }} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] line-through leading-snug" style={{ color: 'var(--text-tertiary)' }}>{task.description}</p>
                  {task.assigned_to && (
                    <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{task.assigned_to}</p>
                  )}
                </div>
                <button type="button" onClick={() => void handleReopen(task.id)}
                  className="flex-shrink-0 text-[11px] px-1"
                  style={{ color: 'var(--text-tertiary)' }}>
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

    </div>
  )
}
