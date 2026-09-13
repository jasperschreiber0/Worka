'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { financialProfile, marginGate } from '@/lib/profitability'
import { money, pct, api } from './ui'
export default function EstimateMarginGate({
  jobId,
  quoteId,
  refreshKey,
}: {
  jobId: string
  quoteId: string
  refreshKey?: unknown
}) {
  const [message, setMessage] = useState('Checking your business margin target…'),
    [status, setStatus] = useState('Financial gate')
  useEffect(() => {
    let active = true
    api(`/api/jobs/${jobId}/intelligence?quoteId=${quoteId}`)
      .then((d) => {
        if (!active) return
        if (!d.profile) {
          setMessage(
            'Set your business financial profile to check whether this estimate covers overhead and target profit.',
          )
          return
        }
        const p = financialProfile(d.profile)
        if (!p.viable || p.minimumMargin === null || p.targetMargin === null) {
          setMessage('Complete your revenue, overhead and profit targets to assess this estimate.')
          return
        }
        const g = marginGate(d.currentCost, d.currentSellPrice, p.minimumMargin, p.targetMargin)
        setStatus(d.currentMissingPrices ? 'INCOMPLETE ESTIMATE' : g.status)
        setMessage(
          `${pct(g.markup)} markup produces ${pct(g.margin)} gross margin. Business target: ${pct(p.targetMargin)}. Target price: ${money(g.recommendedPrice)}.${d.currentMissingPrices ? ' Missing prices must be resolved first.' : ''}`,
        )
      })
      .catch(() => {
        if (active)
          setMessage(
            'Financial profile check unavailable. Open profitability to review your assumptions.',
          )
      })
    return () => {
      active = false
    }
  }, [jobId, quoteId, refreshKey])
  return (
    <section
      className="rounded-lg border p-4 my-4"
      style={{ borderColor: 'var(--bg-border)', background: 'var(--bg-elevated)' }}
    >
      <h3 className="text-sm font-semibold">{status}</h3>
      <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
      <Link className="text-sm underline inline-block mt-3" href={`/jobs/${jobId}/profitability`}>
        Review financial gate and profitability →
      </Link>
    </section>
  )
}
