'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface VariationItem {
  id: string
  job_id: string
  job_address?: string
  title: string
  amount: number
  status: 'draft' | 'pending' | 'approved' | 'rejected'
  created_at: string
  created_display?: string
}

function formatAud(amount: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(amount)
}

const STATUS_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  draft: { label: 'Draft', color: 'var(--text-tertiary)', bg: 'var(--bg-elevated)' },
  pending: { label: 'Awaiting approval', color: 'var(--status-amber)', bg: 'rgba(255,152,0,0.12)' },
  approved: { label: 'Approved', color: 'var(--status-green)', bg: 'rgba(76,175,80,0.13)' },
  rejected: { label: 'Rejected', color: 'var(--status-red)', bg: 'rgba(244,67,54,0.1)' },
}

export default function VariationsListView() {
  const router = useRouter()
  const [variations, setVariations] = useState<VariationItem[] | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/variations')
      if (!res.ok) throw new Error()
      const data = await res.json()
      setVariations(data.variations ?? [])
      setPendingCount(data.pending_count ?? 0)
    } catch {
      setError("Couldn't refresh variations — showing your last known state.")
    }
  }, [])

  useEffect(() => { load() }, [load])

  function openVariation(v: VariationItem) {
    router.push(`/chat?job=${v.job_id}&address=${encodeURIComponent(v.job_address ?? 'View job')}`)
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Variations</h1>
      </div>
      {pendingCount > 0 && (
        <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>{pendingCount} awaiting approval across all jobs</p>
      )}

      {error && (
        <div className="text-sm px-3 py-2 rounded-[6px] mb-4" style={{ background: 'var(--pill-awaiting-bg)', color: 'var(--pill-awaiting-text)' }}>{error}</div>
      )}

      {variations === null && !error && (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-16 rounded-[6px] animate-pulse" style={{ background: 'var(--bg-surface)' }} />)}
        </div>
      )}

      {variations !== null && variations.length === 0 && (
        <div className="flex flex-col items-center text-center gap-2 py-20">
          <p style={{ color: 'var(--text-secondary)' }}>No variations yet. Add one from a job's snapshot panel.</p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {(variations ?? []).map((v) => {
          const s = STATUS_STYLE[v.status] ?? STATUS_STYLE.draft
          return (
            <button key={v.id} onClick={() => openVariation(v)} className="card text-left px-4 py-3 flex items-center justify-between hover:brightness-110 transition-all">
              <div>
                <div style={{ color: 'var(--text-primary)' }}>{v.title}</div>
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {v.job_address ?? `Job ${v.job_id.slice(0, 8)}`} · {v.created_display ?? new Date(v.created_at).toLocaleDateString('en-AU')}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span style={{ color: 'var(--text-primary)' }}>{formatAud(v.amount)}</span>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ color: s.color, background: s.bg }}>{s.label}</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
