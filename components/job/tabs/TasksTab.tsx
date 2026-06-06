'use client'

import { useState } from 'react'
import type { JobTask, JobWorkerRef } from '@/lib/job-snapshot-demo'

// ─── Props ────────────────────────────────────────────────────────────────────

interface TasksTabProps {
  tasks: JobTask[]
  workers: JobWorkerRef[]
  jobId: string
  builderId?: string
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TasksTab({ tasks: initialTasks, workers, jobId, builderId = '00000000-0000-0000-0000-000000000001' }: TasksTabProps) {
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
    } catch {
      // optimistic state remains
    }
  }

  async function handleReopen(taskId: string) {
    setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status: 'open' } : t))
    try {
      await fetch(`/api/jobs/${jobId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reopen', task_id: taskId, builder_id: builderId }),
      })
    } catch {
      // optimistic state remains
    }
  }

  return (
    <div className="p-4 space-y-4">

      {/* ── Open tasks ──────────────────────────────────────────────────────── */}
      <div>
        <p className="text-sm font-medium text-slate-700 mb-2">
          {open.length === 0 ? 'No open tasks' : `${open.length} open task${open.length !== 1 ? 's' : ''}`}
        </p>

        {open.length > 0 && (
          <ul className="space-y-2">
            {open.map((task) => (
              <li key={task.id} className="flex items-start gap-3 bg-white border border-slate-200 rounded-lg px-3 py-3 shadow-sm">
                {/* Complete button */}
                <button
                  type="button"
                  onClick={() => void handleComplete(task.id)}
                  disabled={completing === task.id}
                  className="flex-shrink-0 mt-0.5 w-5 h-5 rounded-full border-2 border-slate-300 hover:border-brand-500 hover:bg-brand-50 transition-colors"
                  aria-label="Mark complete"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-800 leading-snug">{task.description}</p>
                  <div className="flex items-center gap-2 mt-1">
                    {task.assigned_to ? (
                      <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                        </svg>
                        {task.assigned_to}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">Unassigned</span>
                    )}
                    <span className="text-xs text-slate-400">&middot; {task.created_at}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Add task button / form ───────────────────────────────────────────── */}
      {saveError && (
        <button
          type="button"
          onClick={() => { setSaveError(null); setShowForm(true) }}
          className="w-full text-left px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 hover:bg-red-100 transition-colors"
        >
          {saveError}
        </button>
      )}
      {!showForm ? (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors"
        >
          Add task
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-3 shadow-sm">
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
            className="w-full text-sm text-slate-800 placeholder-slate-400 border border-slate-200 rounded-md px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent"
          />

          {/* Worker dropdown */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Assign to</label>
            {workers.length === 0 ? (
              <p className="text-xs text-slate-400 italic">No crew assigned to this job yet.</p>
            ) : (
              <select
                value={selectedWorkerId}
                onChange={(e) => setSelectedWorkerId(e.target.value)}
                className="w-full text-sm text-slate-700 border border-slate-200 rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-brand-400"
              >
                <option value="">Unassigned</option>
                {workers.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} — {w.role}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={!description.trim() || saving}
              className="px-4 py-2 text-xs font-semibold text-white bg-brand-500 hover:bg-brand-600 disabled:opacity-40 rounded-lg transition-colors"
            >
              {saving ? 'Saving…' : 'Add task'}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); setDescription(''); setSelectedWorkerId('') }}
              className="px-4 py-2 text-xs font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Completed tasks ──────────────────────────────────────────────────── */}
      {done.length > 0 && (
        <div className="pt-2 border-t border-slate-100">
          <p className="text-xs font-medium text-slate-400 mb-2 uppercase tracking-wide">
            Completed ({done.length})
          </p>
          <ul className="space-y-2">
            {done.map((task) => (
              <li key={task.id} className="flex items-start gap-3 px-3 py-2.5 bg-slate-50 border border-slate-100 rounded-lg">
                <span className="flex-shrink-0 mt-0.5 w-5 h-5 rounded-full bg-brand-500 flex items-center justify-center">
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1 opacity-60">
                  <p className="text-sm text-slate-500 line-through leading-snug">{task.description}</p>
                  {task.assigned_to && (
                    <p className="text-xs text-slate-400 mt-0.5">{task.assigned_to}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleReopen(task.id)}
                  title="Reopen task"
                  className="flex-shrink-0 text-xs text-slate-400 hover:text-brand-600 transition-colors px-1"
                >
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
