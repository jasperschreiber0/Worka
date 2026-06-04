'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

// ─── Types ────────────────────────────────────────────────────────────────────

interface JobItem {
  id: string
  address: string
  status: string
}

interface JobListProps {
  builderId: string
  userName: string
  userInitials: string
  isDemo: boolean
}

// ─── Status display maps ──────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  quoting: 'Quoting',
  quoted: 'Quoted',
  active: 'Active',
  complete: 'Complete',
  archived: 'Archived',
}

const STATUS_COLOUR: Record<string, string> = {
  active:   'bg-green-100 text-green-700',
  quoted:   'bg-blue-100 text-blue-700',
  quoting:  'bg-amber-100 text-amber-700',
  complete: 'bg-slate-100 text-slate-600',
  archived: 'bg-slate-100 text-slate-400',
}

// ─── Sign-out button ──────────────────────────────────────────────────────────

function SignOutButton({ isDemo }: { isDemo: boolean }) {
  const router = useRouter()
  async function handleSignOut() {
    if (isDemo) { router.push('/login'); return }
    try {
      const { createClientComponentClient } = await import('@supabase/auth-helpers-nextjs')
      await createClientComponentClient().auth.signOut()
      router.push('/login')
      router.refresh()
    } catch {
      router.push('/login')
    }
  }
  return (
    <button
      type="button"
      onClick={handleSignOut}
      className="w-full px-3 py-2 text-sm text-left text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors flex items-center gap-2"
    >
      <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15M12 9l-3 3m0 0 3 3m-3-3h12.75" />
      </svg>
      Sign out
    </button>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function JobList({ builderId, userName, userInitials, isDemo }: JobListProps) {
  const router = useRouter()
  const [jobs, setJobs] = useState<JobItem[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string>('all')
  const [newJobAddress, setNewJobAddress] = useState('')
  const [showNewJob, setShowNewJob] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    fetch(`/api/jobs?builder_id=${builderId}`)
      .then((r) => r.json())
      .then((data: { jobs?: JobItem[] }) => {
        setJobs(data.jobs ?? [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [builderId])

  const filtered = filter === 'all' ? jobs : jobs.filter((j) => j.status === filter)

  const handleCreateJob = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newJobAddress.trim() || creating) return
    setCreating(true)
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: newJobAddress.trim(), builder_id: builderId }),
      })
      const data = await res.json() as { job?: { id: string } }
      if (data.job?.id) {
        router.push(`/jobs/${data.job.id}`)
      } else {
        setCreating(false)
      }
    } catch {
      setCreating(false)
    }
  }, [newJobAddress, creating, builderId, router])

  return (
    <div className="min-h-screen bg-slate-50">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 bg-white border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-brand-500 flex items-center justify-center flex-shrink-0">
              <svg className="w-[15px] h-[15px] text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
              </svg>
            </div>
            <span className="text-base font-bold text-slate-900">WorkA</span>
          </div>

          <div className="flex items-center gap-2">
            {isDemo && (
              <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-700 border border-amber-200">
                Demo
              </span>
            )}
            <Link
              href="/settings"
              className="text-sm text-slate-500 hover:text-slate-700 px-2 py-1 rounded-md hover:bg-slate-50 transition-colors"
            >
              Settings
            </Link>
            <div className="relative group">
              <button
                type="button"
                className="w-8 h-8 rounded-full bg-brand-100 border border-brand-200 flex items-center justify-center text-xs font-semibold text-brand-700 hover:bg-brand-200 transition-colors"
                aria-label="Account menu"
              >
                {userInitials}
              </button>
              <div className="absolute right-0 top-full mt-1 w-44 bg-white border border-slate-200 rounded-xl shadow-lg py-1 hidden group-focus-within:block z-50">
                <div className="px-3 py-2 border-b border-slate-100">
                  <p className="text-xs font-semibold text-slate-900 truncate">{userName}</p>
                  {isDemo && <p className="text-xs text-amber-600">Demo mode</p>}
                </div>
                <SignOutButton isDemo={isDemo} />
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* ── Page content ────────────────────────────────────────────────────── */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {/* Title + actions */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Your jobs</h1>
            {!loading && (
              <p className="text-sm text-slate-500 mt-0.5">
                {jobs.length} job{jobs.length !== 1 ? 's' : ''}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowNewJob((v) => !v)}
            className="btn-primary text-sm px-4 py-2"
          >
            + New job
          </button>
        </div>

        {/* New job form */}
        {showNewJob && (
          <div className="mb-6 bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Create new job</h2>
            <form onSubmit={handleCreateJob} className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={newJobAddress}
                onChange={(e) => setNewJobAddress(e.target.value)}
                placeholder="Job address — e.g. 14 Smith St, Fitzroy VIC 3065"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-transparent"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={creating || !newJobAddress.trim()}
                  className="btn-primary text-sm px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {creating ? 'Creating…' : 'Create job'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowNewJob(false); setNewJobAddress('') }}
                  className="text-sm text-slate-500 hover:text-slate-700 px-3 py-2"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Filter tabs */}
        <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1 scrollbar-none">
          {['all', 'active', 'quoted', 'quoting'].map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                filter === f
                  ? 'bg-brand-500 text-white'
                  : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {f === 'all' ? 'All jobs' : STATUS_LABEL[f] ?? f}
            </button>
          ))}
        </div>

        {/* Job list */}
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-[60px] bg-white rounded-xl border border-slate-200 animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-sm text-slate-400 mb-3">
              {filter !== 'all' ? `No ${STATUS_LABEL[filter]?.toLowerCase()} jobs.` : 'No jobs yet.'}
            </p>
            {filter === 'all' && (
              <button
                type="button"
                onClick={() => setShowNewJob(true)}
                className="text-sm text-brand-600 hover:underline"
              >
                Create your first job →
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((job) => (
              <Link
                key={job.id}
                href={`/jobs/${job.id}`}
                className="flex items-center justify-between bg-white rounded-xl border border-slate-200 hover:border-brand-300 hover:shadow-sm transition-all px-4 py-3.5 group"
              >
                <p className="text-sm font-semibold text-slate-900 truncate group-hover:text-brand-700 transition-colors min-w-0 mr-3">
                  {job.address}
                </p>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      STATUS_COLOUR[job.status] ?? 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {STATUS_LABEL[job.status] ?? job.status}
                  </span>
                  <svg
                    className="w-4 h-4 text-slate-300 group-hover:text-brand-400 transition-colors"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                  </svg>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
