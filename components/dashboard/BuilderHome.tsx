'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import type { DashboardData } from '@/app/api/dashboard/route'

const money = (value: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(value)

export default function BuilderHome({ business = false }: { business?: boolean }) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState(false)
  const load = useCallback(async () => {
    setError(false)
    try {
      const response = await fetch('/api/dashboard')
      if (!response.ok) throw new Error('Unable to load')
      setData(await response.json())
    } catch { setError(true) }
  }, [])
  useEffect(() => { void load() }, [load])

  return <main className="max-w-4xl mx-auto px-4 sm:px-8 py-8" style={{ color: 'var(--text-primary)' }}>
    <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
      <div><h1 className="text-2xl font-semibold">{business ? 'Business' : 'Today'}</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>{business ? 'Your jobs and money at a glance.' : 'See what needs your attention, then get on with the job.'}</p></div>
      <Link href="/jobs?new=1" className="btn-primary px-4 py-3 text-sm">+ New job</Link>
    </div>
    {data?.demo && <p className="mb-6 text-sm" style={{ color: 'var(--status-amber)' }}>Sample jobs — these figures are for demonstration.</p>}
    {error && <div role="alert" className="card p-4 mb-6"><p>Couldn’t refresh your job summary.{data ? ' The figures below may be out of date.' : ''}</p><button onClick={load} className="btn-secondary px-4 py-3 mt-3">Try again</button></div>}
    {!data && !error && <p role="status">Loading your jobs…</p>}
    {data && <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
        {[
          { label: 'Active jobs', value: String(data.stats.active_jobs), href: '/jobs' },
          { label: 'Overdue invoices', value: money(data.stats.overdue_invoice_total), href: '/today' },
          { label: 'Variations awaiting approval', value: String(data.stats.pending_variations), href: '/variations' },
        ].map(item => <Link key={item.label} href={item.href} className="card p-5"><p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{item.label}</p><p className="text-2xl font-semibold mt-2">{item.value}</p></Link>)}
      </div>
      {business ? <>
        <div className="card p-5 mb-6"><h2 className="font-semibold">Invoices due in the next 7 days</h2><p className="text-2xl mt-2">{money(data.stats.revenue_due_this_week)}</p><p className="text-sm mt-3" style={{ color: 'var(--text-secondary)' }}>Based on issued invoices. This is money due, not profit or guaranteed receipts.</p></div>
        <div className="card p-5 mb-8"><h2 className="font-semibold">Expected profit</h2><p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>Not available yet. A reliable forecast needs outstanding commitments and costs to finish, as well as costs already logged. Open a job to review its recorded money.</p><Link className="inline-block mt-4 underline" href="/jobs">Review job money</Link></div>
        <h2 className="font-semibold mb-3">Manage your business</h2><div className="grid sm:grid-cols-2 gap-3">{[['Team', '/team'], ['Suppliers', '/suppliers'], ['Variations', '/variations'], ['Settings', '/settings']].map(([label, href]) => <Link key={href} className="card p-4" href={href}>{label} →</Link>)}</div>
      </> : <>
        <h2 className="text-lg font-semibold mb-4">Needs attention</h2>
        <div className="space-y-3">{data.feed.map(item => <Link href={`/jobs/${item.job_id}`} key={item.job_id} className="card block p-5"><h3 className="font-semibold">{item.address}</h3><p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>{item.ai_reasoning}</p><span className="inline-block mt-3 text-sm" style={{ color: 'var(--orange-primary)' }}>Open job →</span></Link>)}</div>
        {data.feed.length === 0 && <div className="card p-6"><p>No items in your attention list.</p><p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>Open your jobs to check progress and keep their information up to date.</p></div>}
        <div className="flex gap-6 mt-6 text-sm"><Link href="/jobs" className="underline">View all jobs</Link><Link href="/chat" className="underline">Ask Worka</Link></div>
      </>}
    </>}
  </main>
}
