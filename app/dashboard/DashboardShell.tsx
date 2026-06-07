'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import UniversalDropZone from '@/components/dashboard/UniversalDropZone'
import NeedsAttentionSection from '@/components/dashboard/NeedsAttentionSection'
import AIRecommendationsSection from '@/components/dashboard/AIRecommendationsSection'
import RecentActivityFeed from '@/components/dashboard/RecentActivityFeed'
import type { DashboardData } from '@/app/api/dashboard/route'

interface DashboardShellProps {
  builderId: string
  userName: string
  userInitials: string
}

function greeting(name: string): string {
  const hour = new Date().getHours()
  const first = name.split(' ')[0]
  if (hour < 12) return `Good morning, ${first}.`
  if (hour < 17) return `Good afternoon, ${first}.`
  return `Good evening, ${first}.`
}

function formatDate(): string {
  return new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

export default function DashboardShell({ builderId, userName, userInitials }: DashboardShellProps) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  useEffect(() => {
    fetch(`/api/dashboard?builder_id=${builderId}`)
      .then(r => r.json())
      .then((d: DashboardData) => {
        setData(d)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [builderId])

  const handleJobOpen = useCallback((jobId: string) => {
    router.push(`/chat?job=${jobId}`)
  }, [router])

  const stats = data?.stats

  return (
    <div className="min-h-screen bg-slate-50">
      {/* ── Top nav ────────────────────────────────────────────────────────────── */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-4">
          {/* Logo */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-lg font-bold text-slate-900 tracking-tight">WorkA</span>
            <span className="hidden sm:inline-block text-[10px] font-mono text-slate-400 leading-none"
              title={`v${process.env.NEXT_PUBLIC_APP_VERSION} · ${process.env.NEXT_PUBLIC_COMMIT_SHA}`}>
              v{process.env.NEXT_PUBLIC_APP_VERSION}·{process.env.NEXT_PUBLIC_COMMIT_SHA}
            </span>
          </div>

          {/* Nav */}
          <nav className="flex items-center gap-1 ml-4">
            <span className="px-3 py-1.5 text-sm font-medium text-brand-600 bg-brand-50 rounded-md">
              Dashboard
            </span>
            <Link href="/chat" className="px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors">
              Chat
            </Link>
            <Link href="/settings" className="px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors">
              Settings
            </Link>
          </nav>

          {/* Right: user initials */}
          <div className="ml-auto flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-brand-500 flex items-center justify-center flex-shrink-0">
              <span className="text-xs font-semibold text-white">{userInitials}</span>
            </div>
          </div>
        </div>
      </header>

      {/* ── Main content ───────────────────────────────────────────────────────── */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Greeting */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">{greeting(userName)}</h1>
          <p className="text-sm text-slate-500 mt-0.5">{formatDate()}</p>
        </div>

        {/* Stats bar */}
        {stats && (
          <div className="grid grid-cols-3 gap-3 mb-8">
            <div className="bg-white rounded-lg border border-slate-200 px-4 py-3 text-center">
              <p className="text-2xl font-bold text-slate-900">{stats.active_jobs}</p>
              <p className="text-xs text-slate-500 mt-0.5">Active jobs</p>
            </div>
            <div className={`bg-white rounded-lg border px-4 py-3 text-center ${stats.pending_variations > 0 ? 'border-amber-200' : 'border-slate-200'}`}>
              <p className={`text-2xl font-bold ${stats.pending_variations > 0 ? 'text-amber-600' : 'text-slate-900'}`}>{stats.pending_variations}</p>
              <p className="text-xs text-slate-500 mt-0.5">Variations pending</p>
            </div>
            <div className={`bg-white rounded-lg border px-4 py-3 text-center ${stats.overdue_invoices > 0 ? 'border-red-200' : 'border-slate-200'}`}>
              <p className={`text-2xl font-bold ${stats.overdue_invoices > 0 ? 'text-red-600' : 'text-slate-900'}`}>{stats.overdue_invoices}</p>
              <p className="text-xs text-slate-500 mt-0.5">Overdue invoices</p>
            </div>
          </div>
        )}

        {/* Drop zone */}
        <div className="mb-8">
          <UniversalDropZone onJobOpen={handleJobOpen} />
        </div>

        {/* Three-column grid */}
        {loading ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {[1, 2, 3].map(i => (
              <div key={i} className="space-y-3">
                <div className="h-4 bg-slate-200 rounded animate-pulse w-32" />
                {[1, 2, 3].map(j => (
                  <div key={j} className="bg-white rounded-lg border border-slate-100 px-4 py-3">
                    <div className="h-3.5 bg-slate-200 rounded animate-pulse w-full mb-2" />
                    <div className="h-3 bg-slate-200 rounded animate-pulse w-2/3" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : data ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <NeedsAttentionSection alerts={data.alerts} onJobOpen={handleJobOpen} />
            <AIRecommendationsSection recommendations={data.recommendations} />
            <RecentActivityFeed activity={data.activity} />
          </div>
        ) : (
          <p className="text-sm text-slate-400 text-center py-8">Could not load dashboard data.</p>
        )}
      </main>
    </div>
  )
}
