'use client'
import type { ReactNode } from 'react'
export const money = (n: number | null | undefined) =>
  n == null
    ? 'Not available'
    : new Intl.NumberFormat('en-AU', {
        style: 'currency',
        currency: 'AUD',
        maximumFractionDigits: 0,
      }).format(n)
export const pct = (n: number | null | undefined) =>
  n == null ? 'Not available' : `${n.toFixed(1)}%`
export function Field({
  label,
  value,
  onChange,
  nullable = false,
  min = 0,
}: {
  label: string
  value: number | null
  onChange: (n: number | null) => void
  nullable?: boolean
  min?: number
}) {
  return (
    <label className="pi-field">
      <span>{label}</span>
      <input
        type="number"
        step="any"
        min={min}
        value={value ?? ''}
        onChange={(e) =>
          onChange(e.target.value === '' && nullable ? null : Number(e.target.value))
        }
      />
    </label>
  )
}
export function TextField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (s: string) => void
}) {
  return (
    <label className="pi-field">
      <span>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}
export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pi-card">
      <h2>{title}</h2>
      {children}
    </section>
  )
}
export function Metrics({ values }: { values: [string, string][] }) {
  return (
    <dl className="pi-metrics">
      {values.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}
export async function api(url: string, body?: unknown, method = 'POST') {
  const r = await fetch(
    url,
    body
      ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : undefined,
  )
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'Unable to save. Please retry.')
  return d
}
