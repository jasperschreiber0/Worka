'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'

interface VariationDetail {
  id: string
  title: string
  description: string
  amount: number
  status: 'draft' | 'pending' | 'approved' | 'rejected'
  variation_ref?: string
  job_address: string
  labour_cost?: number
  materials_cost?: number
  created_display: string
  submitted_by?: string
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

export default function VariationApprovalPage() {
  const params = useParams<{ variationId: string }>()
  const variationId = params.variationId

  const [variation, setVariation] = useState<VariationDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [result, setResult] = useState<'approved' | 'rejected' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [clientName, setClientName] = useState('')
  const [showNamePrompt, setShowNamePrompt] = useState(false)
  const [pendingAction, setPendingAction] = useState<'approved' | 'rejected' | null>(null)

  useEffect(() => {
    fetch(`/api/variations/${variationId}`)
      .then(r => r.json())
      .then((data: { variation?: VariationDetail; error?: string }) => {
        if (data.error || !data.variation) {
          setError('Variation not found.')
        } else {
          setVariation(data.variation)
          if (data.variation.status === 'approved') setResult('approved')
          if (data.variation.status === 'rejected') setResult('rejected')
        }
      })
      .catch(() => setError('Could not load variation details.'))
      .finally(() => setLoading(false))
  }, [variationId])

  async function submitDecision(decision: 'approved' | 'rejected', name: string) {
    setActionLoading(true)
    try {
      const res = await fetch(`/api/variations/${variationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: decision, approved_by: name || 'Client' }),
      })
      if (!res.ok) throw new Error('Failed')
      setResult(decision)
      setShowNamePrompt(false)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setActionLoading(false)
    }
  }

  function handleAction(decision: 'approved' | 'rejected') {
    setPendingAction(decision)
    setShowNamePrompt(true)
  }

  function confirmAction() {
    if (!pendingAction) return
    void submitDecision(pendingAction, clientName)
  }

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#0f1117' }}>
        <div className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'rgba(255,107,43,0.3)', borderTopColor: '#ff6b2b' }} />
      </div>
    )
  }

  // ── Error ────────────────────────────────────────────────────────────────────
  if (error || !variation) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ backgroundColor: '#0f1117' }}>
        <div className="w-full max-w-sm text-center">
          <p className="text-[15px] font-semibold mb-2" style={{ color: '#f1f5f9' }}>Link not found</p>
          <p className="text-[13px]" style={{ color: '#64748b' }}>{error ?? 'This variation link is invalid or expired.'}</p>
        </div>
      </div>
    )
  }

  // ── Already actioned ─────────────────────────────────────────────────────────
  if (result) {
    const isApproved = result === 'approved'
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ backgroundColor: '#0f1117' }}>
        <div className="w-full max-w-sm rounded-2xl p-8 text-center" style={{ backgroundColor: '#1a1f2e', border: '0.5px solid rgba(255,255,255,0.08)' }}>
          <div
            className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5"
            style={{ backgroundColor: isApproved ? 'rgba(76,175,80,0.15)' : 'rgba(244,67,54,0.1)' }}
          >
            {isApproved ? (
              <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: '#4caf50' }} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
            ) : (
              <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: '#f44336' }} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
          </div>
          <h1 className="text-[18px] font-bold mb-2" style={{ color: '#f1f5f9' }}>
            {isApproved ? 'Variation approved' : 'Variation rejected'}
          </h1>
          <p className="text-[13px] leading-relaxed" style={{ color: '#94a3b8' }}>
            {isApproved
              ? 'Your builder has been notified. They will update the project schedule and invoice accordingly.'
              : 'Your builder has been notified. They will follow up with you shortly.'}
          </p>
          <p className="text-[11px] mt-5 font-medium" style={{ color: '#ff6b2b' }}>Powered by WorkA</p>
        </div>
      </div>
    )
  }

  // ── Name prompt overlay ──────────────────────────────────────────────────────
  const namePromptOverlay = showNamePrompt && (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}>
      <div className="w-full max-w-sm rounded-2xl p-6" style={{ backgroundColor: '#1a1f2e', border: '0.5px solid rgba(255,255,255,0.08)' }}>
        <p className="text-[15px] font-semibold mb-1" style={{ color: '#f1f5f9' }}>Confirm your name</p>
        <p className="text-[12px] mb-4" style={{ color: '#64748b' }}>This will be recorded on the variation approval.</p>
        <input
          type="text"
          placeholder="Your name"
          value={clientName}
          onChange={e => setClientName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') confirmAction() }}
          autoFocus
          className="w-full rounded-lg px-3 py-2.5 text-[13px] outline-none mb-4"
          style={{ backgroundColor: '#0f1117', border: '0.5px solid rgba(255,255,255,0.12)', color: '#f1f5f9' }}
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowNamePrompt(false)}
            className="flex-1 py-2.5 rounded-lg text-[13px] font-medium"
            style={{ backgroundColor: 'rgba(255,255,255,0.06)', color: '#94a3b8' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmAction}
            disabled={actionLoading}
            className="flex-1 py-2.5 rounded-lg text-[13px] font-semibold disabled:opacity-60"
            style={{
              backgroundColor: pendingAction === 'approved' ? '#4caf50' : '#f44336',
              color: '#fff',
            }}
          >
            {actionLoading ? 'Saving…' : pendingAction === 'approved' ? 'Confirm approval' : 'Confirm rejection'}
          </button>
        </div>
      </div>
    </div>
  )

  // ── Main view ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen px-4 py-10" style={{ backgroundColor: '#0f1117' }}>
      {namePromptOverlay}

      <div className="max-w-md mx-auto">
        {/* Logo */}
        <div className="flex items-center gap-2 mb-8">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: '#ff6b2b' }}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: '#fff' }} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
            </svg>
          </div>
          <span className="text-[16px] font-bold" style={{ color: '#f1f5f9' }}>WorkA</span>
        </div>

        {/* Card */}
        <div className="rounded-2xl p-6" style={{ backgroundColor: '#1a1f2e', border: '0.5px solid rgba(255,255,255,0.08)' }}>
          {/* Header */}
          <div className="mb-5">
            <p className="text-[11px] font-mono mb-1" style={{ color: '#ff6b2b' }}>{variation.variation_ref ?? 'VAR'}</p>
            <h1 className="text-[17px] font-bold mb-1" style={{ color: '#f1f5f9' }}>{variation.title}</h1>
            <p className="text-[12px]" style={{ color: '#64748b' }}>{variation.job_address} &middot; Submitted {variation.created_display}</p>
          </div>

          {/* Description */}
          <p className="text-[13px] leading-relaxed mb-5" style={{ color: '#94a3b8' }}>{variation.description}</p>

          {/* Cost breakdown */}
          <div className="rounded-lg p-4 mb-5" style={{ backgroundColor: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.06)' }}>
            {variation.labour_cost !== undefined && variation.labour_cost > 0 && (
              <div className="flex justify-between items-center mb-2">
                <span className="text-[12px]" style={{ color: '#64748b' }}>Labour</span>
                <span className="text-[12px]" style={{ color: '#94a3b8' }}>{formatCurrency(variation.labour_cost)}</span>
              </div>
            )}
            {variation.materials_cost !== undefined && variation.materials_cost > 0 && (
              <div className="flex justify-between items-center mb-2">
                <span className="text-[12px]" style={{ color: '#64748b' }}>Materials</span>
                <span className="text-[12px]" style={{ color: '#94a3b8' }}>{formatCurrency(variation.materials_cost)}</span>
              </div>
            )}
            <div className="flex justify-between items-center pt-2" style={{ borderTop: variation.labour_cost || variation.materials_cost ? '0.5px solid rgba(255,255,255,0.08)' : 'none' }}>
              <span className="text-[13px] font-semibold" style={{ color: '#f1f5f9' }}>Total</span>
              <span className="text-[15px] font-bold" style={{ color: '#ff6b2b' }}>{formatCurrency(variation.amount)}</span>
            </div>
          </div>

          {/* Notice */}
          <p className="text-[11px] leading-relaxed mb-5" style={{ color: '#475569' }}>
            By approving this variation, you authorise your builder to proceed with the additional work and agree to pay the amount above as an addition to your contract.
          </p>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => handleAction('rejected')}
              disabled={actionLoading}
              className="flex-1 py-3 rounded-xl text-[14px] font-semibold disabled:opacity-50"
              style={{ backgroundColor: 'rgba(244,67,54,0.12)', color: '#f44336', border: '0.5px solid rgba(244,67,54,0.3)' }}
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => handleAction('approved')}
              disabled={actionLoading}
              className="flex-[2] py-3 rounded-xl text-[14px] font-semibold disabled:opacity-50"
              style={{ backgroundColor: '#4caf50', color: '#fff' }}
            >
              Approve — {formatCurrency(variation.amount)}
            </button>
          </div>
        </div>

        <p className="text-center text-[11px] mt-6" style={{ color: '#334155' }}>
          Sent by your builder via WorkA &middot; Questions? Reply to their email.
        </p>
      </div>
    </div>
  )
}
