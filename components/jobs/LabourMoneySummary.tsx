'use client'
import { useEffect, useState } from 'react'

export default function LabourMoneySummary({ jobId }: { jobId: string }) {
  const [summary, setSummary] = useState<{ hours: number; value: number; missing: number } | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    fetch(`/api/jobs/${jobId}/hours`).then(async response => {
      if (!response.ok) throw new Error('Hours unavailable')
      const data = await response.json()
      const totals = (data.hours as Array<{ hours: number; hourly_rate: number | null }>).reduce((sum, row) => ({ hours: sum.hours + Number(row.hours), value: sum.value + (row.hourly_rate == null ? 0 : Number(row.hours) * Number(row.hourly_rate)), missing: sum.missing + (row.hourly_rate == null ? Number(row.hours) : 0) }), { hours: 0, value: 0, missing: 0 })
      if (active) setSummary(totals)
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [jobId])
  return <section className="card p-4 mb-4"><h2 className="font-semibold">Labour check</h2>{error ? <p role="alert">Could not load labour. Refresh to try again.</p> : !summary ? <p role="status">Loading labour…</p> : <><p className="mt-2">{summary.hours.toFixed(2)} hours · {new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(summary.value)} recorded labour value</p>{summary.missing > 0 && <p>{summary.missing.toFixed(2)} hours still need a rate.</p>}<p className="text-sm mt-2">Latest 100 entries. Compare this value with your logged costs before adding labour to the forecast. It is not automatically added to actual costs because bills or manual entries may already include it.</p></>}</section>
}
