'use client'

import { useState, useEffect } from 'react'
import type { JobSnapshot } from '@/lib/job-snapshot-demo'
import OverviewTab from '@/components/job/tabs/OverviewTab'
import QuoteTab from '@/components/job/tabs/QuoteTab'
import VariationsTab from '@/components/job/tabs/VariationsTab'
import InvoicesTab from '@/components/job/tabs/InvoicesTab'
import FilesTab from '@/components/job/tabs/FilesTab'
import CommsTab from '@/components/job/tabs/CommsTab'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActiveJob {
  id: string
  address: string
  status: string
  client_name?: string
}

type TabId = 'overview' | 'quote' | 'variations' | 'invoices' | 'files' | 'comms'

interface Tab {
  id: TabId
  label: string
}

export interface JobSnapshotPanelProps {
  job: ActiveJob | null
  onClose: () => void
  onViewQuote?: (quoteId: string) => void
  onVariationApprove?: (variationId: string) => void
  onComposeEmail?: (jobId: string) => void
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TABS: Tab[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'quote', label: 'Quote' },
  { id: 'variations', label: 'Variations' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'files', label: 'Files' },
  { id: 'comms', label: 'Comms' },
]

function capitalise(str: string): string {
  if (!str) return str
  return str.charAt(0).toUpperCase() + str.slice(1)
}

// ─── Skeleton placeholder ─────────────────────────────────────────────────────

function SkeletonSection() {
  return (
    <div className="p-4 space-y-4">
      {/* Header skeleton */}
      <div className="h-6 w-32 bg-slate-200 rounded animate-pulse" />
      {/* Content skeletons */}
      <div className="space-y-3">
        <div className="h-4 w-full bg-slate-200 rounded animate-pulse" />
        <div className="h-4 w-full bg-slate-200 rounded animate-pulse" />
        <div className="h-4 w-4/5 bg-slate-200 rounded animate-pulse" />
      </div>
      {/* Second block */}
      <div className="h-6 w-24 bg-slate-200 rounded animate-pulse mt-6" />
      <div className="space-y-3">
        <div className="h-4 w-full bg-slate-200 rounded animate-pulse" />
        <div className="h-4 w-3/4 bg-slate-200 rounded animate-pulse" />
        <div className="h-4 w-full bg-slate-200 rounded animate-pulse" />
      </div>
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function JobSnapshotPanel({ job, onClose, onViewQuote, onVariationApprove, onComposeEmail }: JobSnapshotPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null)
  const [loading, setLoading] = useState(false)

  // Fetch snapshot when job changes
  useEffect(() => {
    if (!job) {
      setSnapshot(null)
      return
    }
    setLoading(true)
    fetch(`/api/jobs/${job.id}/snapshot`)
      .then((r) => r.json())
      .then((data: { snapshot: JobSnapshot }) => {
        setSnapshot(data.snapshot)
        setLoading(false)
      })
      .catch(() => {
        setLoading(false)
      })
  }, [job?.id])

  // Reset to overview tab when job changes
  useEffect(() => {
    setActiveTab('overview')
  }, [job?.id])

  // Render the active tab content
  function renderTabContent() {
    if (loading || !snapshot) {
      return <SkeletonSection />
    }

    switch (activeTab) {
      case 'overview':
        return <OverviewTab overview={snapshot.overview} job={snapshot.job} />
      case 'quote':
        return (
          <QuoteTab
            quote={snapshot.quote}
            onViewQuote={onViewQuote ?? (() => {})}
          />
        )
      case 'variations':
        return (
          <VariationsTab
            variations={snapshot.variations}
            jobAddress={snapshot.job.address}
            onApprove={onVariationApprove}
            onReject={() => {
              // Reject from panel — no notification needed
            }}
          />
        )
      case 'invoices':
        return <InvoicesTab invoices={snapshot.invoices} />
      case 'files':
        return <FilesTab files={snapshot.files} />
      case 'comms':
        return (
          <CommsTab
            comms={snapshot.comms}
            onComposeEmail={job && onComposeEmail ? () => onComposeEmail(job.id) : undefined}
          />
        )
      default:
        return <SkeletonSection />
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-4 pt-4 pb-3 border-b border-slate-200 bg-white">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900 truncate">
              {job?.address ?? 'No job selected'}
            </h2>
            <p className="text-sm text-slate-500 mt-0.5">
              {job ? (
                <>
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium mr-1.5 ${
                      job.status === 'active'
                        ? 'bg-green-100 text-green-700'
                        : job.status === 'quoted'
                          ? 'bg-blue-100 text-blue-700'
                          : job.status === 'quoting'
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {capitalise(job.status)}
                  </span>
                  {job.client_name && <span>{job.client_name} job</span>}
                </>
              ) : (
                'Ask about a job to see details here'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            aria-label="Close job snapshot"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Tab bar ─────────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-b border-slate-200 bg-white px-4">
        <div className="flex gap-0 overflow-x-auto scrollbar-hide -mb-px">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex-shrink-0 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-brand-500 text-brand-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto bg-slate-50">
        {job ? (
          renderTabContent()
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-3">
              <svg
                className="w-6 h-6 text-slate-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21"
                />
              </svg>
            </div>
            <p className="text-sm text-slate-500">Ask about a specific job to see its details here.</p>
          </div>
        )}
      </div>
    </div>
  )
}
