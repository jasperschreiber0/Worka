'use client'

import { useCallback, useEffect, useState } from 'react'
import AddWorkerDrawer from './AddWorkerDrawer'
import WorkerModal from '@/components/chat/WorkerModal'
import type { Worker } from '@/lib/types/database.types'
import type { WorkerListItem } from '@/app/api/workers/route'

function AvailabilityPill({ worker }: { worker: WorkerListItem }) {
  if (worker.status === 'invited') {
    return <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ color: 'var(--status-amber)', background: 'rgba(255,152,0,0.12)' }}>Invited</span>
  }
  const available = worker.available !== false
  return (
    <span
      className="text-[11px] font-medium px-2 py-0.5 rounded-full"
      style={{ color: available ? 'var(--status-green)' : 'var(--text-tertiary)', background: available ? 'rgba(76,175,80,0.13)' : 'var(--bg-elevated)' }}
    >
      {available ? 'Available' : 'Unavailable'}
    </span>
  )
}

export default function TeamView() {
  const [workers, setWorkers] = useState<WorkerListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [newWorkerModal, setNewWorkerModal] = useState<{ worker: Worker; inviteUrl: string } | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/workers')
      if (!res.ok) throw new Error()
      const data = await res.json()
      setWorkers(data.workers ?? [])
    } catch {
      setError("Couldn't load your crew — showing your last known state.")
    }
  }, [])

  useEffect(() => { load() }, [load])

  function handleCreated(worker: WorkerListItem, inviteUrl: string) {
    setDrawerOpen(false)
    setWorkers((prev) => [worker, ...(prev ?? [])])
    setNewWorkerModal({ worker: worker as unknown as Worker, inviteUrl })
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Team</h1>
        <button className="btn-primary px-4 py-2 text-sm" onClick={() => setDrawerOpen(true)}>+ Add worker</button>
      </div>

      {error && (
        <div className="text-sm px-3 py-2 rounded-[6px] mb-4" style={{ background: 'var(--pill-awaiting-bg)', color: 'var(--pill-awaiting-text)' }}>{error}</div>
      )}

      {workers === null && !error && (
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => <div key={i} className="h-16 rounded-[6px] animate-pulse" style={{ background: 'var(--bg-surface)' }} />)}
        </div>
      )}

      {workers !== null && workers.length === 0 && (
        <div className="flex flex-col items-center text-center gap-3 py-20">
          <p style={{ color: 'var(--text-secondary)' }}>No crew yet. Add your first worker to start assigning jobs.</p>
          <button className="btn-primary px-4 py-2 text-sm" onClick={() => setDrawerOpen(true)}>+ Add worker</button>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {(workers ?? []).map((worker) => (
          <div key={worker.id} className="card px-4 py-3 flex items-center justify-between">
            <div>
              <div style={{ color: 'var(--text-primary)' }}>{worker.name}</div>
              <div className="text-xs capitalize" style={{ color: 'var(--text-secondary)' }}>
                {worker.role}
                {worker.hourly_rate ? ` · $${worker.hourly_rate}/hr` : ''}
              </div>
            </div>
            <AvailabilityPill worker={worker} />
          </div>
        ))}
      </div>

      <AddWorkerDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onCreated={handleCreated} />
      {newWorkerModal && (
        <WorkerModal
          isOpen={true}
          onClose={() => setNewWorkerModal(null)}
          worker={newWorkerModal.worker}
          inviteUrl={newWorkerModal.inviteUrl}
        />
      )}
    </div>
  )
}
