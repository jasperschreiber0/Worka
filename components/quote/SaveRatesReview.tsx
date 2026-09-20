'use client'

import { useState } from 'react'
import type { DemoQuoteLineItem } from '@/lib/quote-demo'

function fingerprint(item: DemoQuoteLineItem) {
  return JSON.stringify([item.id, item.description, item.trade_category_id, item.unit, item.rate])
}

export default function SaveRatesReview({ items, onSaved }: {
  items: DemoQuoteLineItem[]
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [saved, setSaved] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const eligible = items.filter(item => item.pricing_source === 'manual'
    && item.pricing_type === 'measured'
    && item.assumption_status !== 'excluded' && item.assumption_status !== 'unresolved'
    && item.rate !== null && Number.isFinite(item.rate) && item.rate > 0
    && item.quantity !== null && Number.isFinite(item.quantity) && item.quantity > 0
    && !!item.unit?.trim() && !saved.includes(fingerprint(item)))
  const chosen = eligible.filter(item => selected.includes(fingerprint(item)))

  async function save() {
    if (busy || !chosen.length) return
    setBusy(true)
    setMessage('Saving your selected rates…')
    const successes: string[] = []
    const failures: string[] = []
    for (const item of chosen) {
      try {
        const response = await fetch(`/api/quotes/${item.quote_id}/line-items/${item.id}/save-rate`, { method: 'POST' })
        if (!response.ok) throw new Error('Save failed')
        successes.push(fingerprint(item))
      } catch {
        failures.push(item.description)
      }
    }
    setSaved(previous => [...previous, ...successes])
    setSelected(previous => previous.filter(key => !successes.includes(key)))
    setMessage(`${successes.length} rate${successes.length === 1 ? '' : 's'} saved for matching future work.${failures.length ? ` ${failures.length} could not be saved. Retry the remaining selected rates.` : ''}`)
    setBusy(false)
    if (successes.length) onSaved()
    if (!failures.length) setOpen(false)
  }

  if (!eligible.length && !message) return null
  return <section className="mx-4 mb-4 p-4 rounded-xl" style={{ border: '1px solid var(--bg-border)', background: 'var(--bg-surface)' }}>
    <h3 className="font-semibold">Use these prices again?</h3>
    <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>Your prices are already included in this estimate. Optionally save unit rates to your account for matching scope and units in future estimates. Allowances are excluded. Saving replaces an existing rate for the same scope and unit.</p>
    {!open && eligible.length > 0 && <button type="button" className="btn-secondary px-3 py-2 mt-3" onClick={() => { setSelected(eligible.map(fingerprint)); setOpen(true); setMessage('') }}>Review {eligible.length} unit rates</button>}
    {open && <>
      <div className="flex gap-3 mt-3">
        <button type="button" className="btn-secondary px-3 py-2 text-sm" disabled={busy} onClick={() => setSelected(eligible.map(fingerprint))}>Select all</button>
        <button type="button" className="btn-secondary px-3 py-2 text-sm" disabled={busy} onClick={() => setSelected([])}>Clear selection</button>
      </div>
      <div className="mt-3 max-h-80 overflow-y-auto">
        {eligible.map(item => <label key={item.id} className="flex items-start gap-3 py-3" style={{ borderBottom: '1px solid var(--bg-border)' }}>
          <input type="checkbox" className="mt-1" disabled={busy} checked={selected.includes(fingerprint(item))} onChange={event => { const key = fingerprint(item); setSelected(previous => event.target.checked ? [...previous, key] : previous.filter(value => value !== key)) }} />
          <span className="text-sm"><span className="block">{item.description}</span><span className="block text-xs mt-1">{item.trade_category_name} · {item.rate!.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })} / {item.unit}</span></span>
        </label>)}
      </div>
      <div className="flex flex-wrap gap-3 mt-3">
        <button type="button" className="btn-primary px-3 py-2" disabled={busy || !chosen.length} onClick={save}>{busy ? 'Saving…' : `Confirm and save ${chosen.length} rates`}</button>
        <button type="button" className="btn-secondary px-3 py-2" disabled={busy} onClick={() => setOpen(false)}>Not now</button>
      </div>
    </>}
    {message && <p role="status" className="text-sm mt-3">{message}</p>}
  </section>
}
