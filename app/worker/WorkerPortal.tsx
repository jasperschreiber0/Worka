'use client'

import { useState } from 'react'
import type { DemoWorker, DemoWorkerJob } from '@/lib/worker-demo'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function urgencyClass(urgency: DemoWorkerJob['milestone_due_urgency']) {
  switch (urgency) {
    case 'overdue': return 'text-red-600 bg-red-50 border-red-200'
    case 'soon':    return 'text-amber-700 bg-amber-50 border-amber-200'
    default:        return 'text-green-700 bg-green-50 border-green-200'
  }
}

// ─── Site card ────────────────────────────────────────────────────────────────

function SiteCard({ job }: { job: DemoWorkerJob }) {
  const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(job.address + ' ' + job.suburb)}`

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Address banner */}
      <div className="bg-brand-500 px-4 pt-5 pb-4">
        <p className="text-xs font-semibold text-brand-100 uppercase tracking-wide mb-1">
          Today&apos;s site
        </p>
        <p className="text-xl font-bold text-white leading-tight">{job.address}</p>
        <p className="text-sm text-brand-100">{job.suburb}</p>
      </div>

      <div className="px-4 py-4 space-y-3">
        {/* Start time + milestone */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
            <span className="text-sm font-semibold text-slate-800">Start {job.start_time}</span>
          </div>
          <span className="text-slate-200">|</span>
          <span className="text-sm text-slate-500">{job.milestone_week}</span>
        </div>

        {/* Milestone */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400 mb-0.5">Current milestone</p>
            <p className="text-sm font-semibold text-slate-900">{job.milestone_label}</p>
          </div>
          <span
            className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold border ${urgencyClass(job.milestone_due_urgency)}`}
          >
            {job.milestone_due_display}
          </span>
        </div>

        {/* Map link */}
        <a
          href={mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
          </svg>
          Open in Maps
        </a>
      </div>
    </div>
  )
}

// ─── Task list ────────────────────────────────────────────────────────────────

function TaskList({ job }: { job: DemoWorkerJob }) {
  const [tasks, setTasks] = useState(job.tasks)
  const done = tasks.filter((t) => t.done).length

  function toggle(i: number) {
    setTasks((prev) => prev.map((t, idx) => idx === i ? { ...t, done: !t.done } : t))
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-bold text-slate-900">Today&apos;s tasks</p>
        <span className="text-xs font-semibold text-slate-400">{done}/{tasks.length}</span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-slate-100 rounded-full mb-4 overflow-hidden">
        <div
          className="h-full bg-brand-500 rounded-full transition-all duration-300"
          style={{ width: `${tasks.length > 0 ? (done / tasks.length) * 100 : 0}%` }}
          role="presentation"
        />
      </div>

      <ul className="space-y-3">
        {tasks.map((task, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => toggle(i)}
              className="flex items-start gap-3 w-full text-left group"
              aria-label={`${task.done ? 'Unmark' : 'Mark'} "${task.label}" as done`}
            >
              <div
                className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${
                  task.done
                    ? 'bg-brand-500 border-brand-500'
                    : 'border-slate-300 group-hover:border-brand-400'
                }`}
              >
                {task.done && (
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                  </svg>
                )}
              </div>
              <span className={`text-sm leading-snug ${task.done ? 'line-through text-slate-400' : 'text-slate-700'}`}>
                {task.label}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─── Quick actions ────────────────────────────────────────────────────────────

function QuickActions({ job }: { job: DemoWorkerJob }) {
  const [photoUploaded, setPhotoUploaded] = useState(false)
  const [issueReported, setIssueReported] = useState(false)

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-4">
      <p className="text-sm font-bold text-slate-900 mb-3">Quick actions</p>
      <div className="grid grid-cols-3 gap-3">
        {/* Call builder */}
        <a
          href={`tel:${job.builder_phone}`}
          className="flex flex-col items-center gap-2 py-3 px-2 rounded-xl bg-brand-50 border border-brand-100 hover:bg-brand-100 transition-colors no-underline"
        >
          <svg className="w-6 h-6 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z" />
          </svg>
          <span className="text-xs font-semibold text-brand-700 text-center leading-tight">
            Call {job.builder_name.split(' ')[0]}
          </span>
        </a>

        {/* Upload photo */}
        <button
          type="button"
          onClick={() => setPhotoUploaded(true)}
          className={`flex flex-col items-center gap-2 py-3 px-2 rounded-xl border transition-colors ${
            photoUploaded
              ? 'bg-green-50 border-green-200'
              : 'bg-slate-50 border-slate-200 hover:bg-slate-100'
          }`}
        >
          {photoUploaded ? (
            <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
          ) : (
            <svg className="w-6 h-6 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
            </svg>
          )}
          <span className={`text-xs font-semibold text-center leading-tight ${photoUploaded ? 'text-green-700' : 'text-slate-600'}`}>
            {photoUploaded ? 'Uploaded' : 'Site photo'}
          </span>
        </button>

        {/* Report issue */}
        <button
          type="button"
          onClick={() => setIssueReported(true)}
          className={`flex flex-col items-center gap-2 py-3 px-2 rounded-xl border transition-colors ${
            issueReported
              ? 'bg-green-50 border-green-200'
              : 'bg-slate-50 border-slate-200 hover:bg-slate-100'
          }`}
        >
          {issueReported ? (
            <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
          ) : (
            <svg className="w-6 h-6 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
          )}
          <span className={`text-xs font-semibold text-center leading-tight ${issueReported ? 'text-green-700' : 'text-slate-600'}`}>
            {issueReported ? 'Reported' : 'Flag issue'}
          </span>
        </button>
      </div>
    </div>
  )
}

// ─── Main portal ──────────────────────────────────────────────────────────────

export default function WorkerPortal({ worker }: { worker: DemoWorker }) {
  const job = worker.jobs[0]

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col max-w-md mx-auto">
      {/* ── Sticky header ─────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 bg-white border-b border-slate-100 px-4 pt-safe">
        <div className="flex items-center justify-between h-14">
          {/* Logo + worker */}
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-brand-500 flex items-center justify-center flex-shrink-0">
              <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-bold text-slate-900 leading-none">{worker.name}</p>
              <p className="text-xs text-slate-400 leading-none mt-0.5">{worker.role}</p>
            </div>
          </div>

          {/* Avatar */}
          <div className="w-9 h-9 rounded-full bg-brand-100 border border-brand-200 flex items-center justify-center">
            <span className="text-xs font-bold text-brand-700">{worker.initials}</span>
          </div>
        </div>
      </header>

      {/* ── Scrollable content ────────────────────────────────────────────── */}
      <main className="flex-1 px-4 py-5 space-y-4 pb-safe">
        {/* Date */}
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
          {new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>

        {job ? (
          <>
            <SiteCard job={job} />
            <TaskList job={job} />
            <QuickActions job={job} />
          </>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
            <p className="text-slate-500 text-sm">No active jobs assigned yet.</p>
            <p className="text-slate-400 text-xs mt-1">Your builder will assign you to a site soon.</p>
          </div>
        )}

        {/* Footer */}
        <p className="text-center text-xs text-slate-300 pb-4">
          WorkA — {worker.builder_company}
        </p>
      </main>
    </div>
  )
}
