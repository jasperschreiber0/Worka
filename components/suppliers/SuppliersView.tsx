'use client'

import { useCallback, useEffect, useState } from 'react'
import AddSupplierDrawer from './AddSupplierDrawer'
import { tradeCategoryName } from '@/lib/trade-taxonomy'
import type { Supplier } from '@/lib/types/database.types'

export default function SuppliersView() {
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/suppliers')
      if (!res.ok) throw new Error()
      const data = await res.json()
      setSuppliers(data.suppliers ?? [])
    } catch {
      setError("Couldn't load your suppliers — showing your last known state.")
    }
  }, [])

  useEffect(() => { load() }, [load])

  function handleCreated(supplier: Supplier) {
    setDrawerOpen(false)
    setSuppliers((prev) => [supplier, ...(prev ?? [])])
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Suppliers</h1>
        <button className="btn-primary px-4 py-2 text-sm" onClick={() => setDrawerOpen(true)}>+ Add supplier</button>
      </div>

      {error && (
        <div className="text-sm px-3 py-2 rounded-[6px] mb-4" style={{ background: 'var(--pill-awaiting-bg)', color: 'var(--pill-awaiting-text)' }}>{error}</div>
      )}

      {suppliers === null && !error && (
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => <div key={i} className="h-16 rounded-[6px] animate-pulse" style={{ background: 'var(--bg-surface)' }} />)}
        </div>
      )}

      {suppliers !== null && suppliers.length === 0 && (
        <div className="flex flex-col items-center text-center gap-3 py-20">
          <p style={{ color: 'var(--text-secondary)' }}>No suppliers yet. Add the ones you use most.</p>
          <button className="btn-primary px-4 py-2 text-sm" onClick={() => setDrawerOpen(true)}>+ Add supplier</button>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {(suppliers ?? []).map((s) => (
          <div key={s.id} className="card px-4 py-3 flex items-center justify-between">
            <div>
              <div style={{ color: 'var(--text-primary)' }}>{s.name}</div>
              <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {s.preferred_trade_category_id ? tradeCategoryName(s.preferred_trade_category_id) : 'General'}
                {s.contact_name ? ` · ${s.contact_name}` : ''}
              </div>
            </div>
            <span
              className="text-[11px] font-medium px-2 py-0.5 rounded-full"
              style={{
                color: s.pricing_agreement_notes ? 'var(--status-green)' : 'var(--text-tertiary)',
                background: s.pricing_agreement_notes ? 'rgba(76,175,80,0.13)' : 'var(--bg-elevated)',
              }}
            >
              {s.pricing_agreement_notes ? 'On file' : 'No agreement'}
            </span>
          </div>
        ))}
      </div>

      <AddSupplierDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onCreated={handleCreated} />
    </div>
  )
}
