'use client'

import { useState, useEffect } from 'react'
import { useParams, useSearchParams } from 'next/navigation'

interface ClientVisibleLineItem {
  description: string
  client_price: number
}

interface ClientVisibleCategory {
  trade_category_id: number
  trade_name: string
  items: ClientVisibleLineItem[]
  subtotal: number
}

interface QuoteDetail {
  status: 'draft' | 'pending_review' | 'sent' | 'approved' | 'rejected'
  job_address: string
  client_name: string
  sent_display: string | null
  approved_at: string | null
  approved_by: string | null
  categories: ClientVisibleCategory[]
  total: number
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

export default function QuoteApprovalPage() {
  const params = useParams<{ quoteId: string }>()
  const quoteId = params.quoteId
  const searchParams = useSearchParams()
  const shareToken = searchParams.get('t')

  const [quote, setQuote] = useState<QuoteDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [result, setResult] = useState<'approved' | 'changes_requested' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [clientName, setClientName] = useState('')
  const [message, setMessage] = useState('')
  const [showPrompt, setShowPrompt] = useState(false)
  const [pendingAction, setPendingAction] = useState<'approved' | 'changes_requested' | null>(null)

  useEffect(() => {
    if (!shareToken) {
      setError('This link is invalid or has expired.')
      setLoading(false)
      return
    }
    fetch(`/api/quotes/${quoteId}/approve?t=${encodeURIComponent(shareToken)}`)
      .then(r => r.json())
      .then((data: { quote?: QuoteDetail; error?: string }) => {
        if (data.error || !data.quote) {
          setError('This link is invalid or has expired.')
        } else {
          setQuote(data.quote)
          if (data.quote.status === 'approved') setResult('approved')
        }
      })
      .catch(() => setError('Could not load quote details.'))
      .finally(() => setLoading(false))
  }, [quoteId, shareToken])

  async function submitDecision(decision: 'approved' | 'changes_requested', name: string, msg: string) {
    setActionLoading(true)
    try {
      const res = await fetch(`/api/quotes/${quoteId}/approve`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, approved_by: name || 'Client', message: msg, t: shareToken }),
      })
      const data = await res.json().catch(() => null) as { error?: string } | null
      if (!res.ok) {
        throw new Error(data?.error ?? 'Failed')
      }
      setResult(decision)
      setShowPrompt(false)
    } catch (err) {
      setError(err instanceof Error && err.message !== 'Failed' ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setActionLoading(false)
    }
  }

  function handleAction(decision: 'approved' | 'changes_requested') {
    setPendingAction(decision)
    setShowPrompt(true)
  }

  function confirmAction() {
    if (!pendingAction) return
    void submitDecision(pendingAction, clientName, message)
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
  if (error || !quote) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ backgroundColor: '#0f1117' }}>
        <div className="w-full max-w-sm text-center">
          <p className="text-[15px] font-semibold mb-2" style={{ color: '#f1f5f9' }}>Link not found</p>
          <p className="text-[13px]" style={{ color: '#64748b' }}>{error ?? 'This quote link is invalid or expired.'}</p>
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
            style={{ backgroundColor: isApproved ? 'rgba(76,175,80,0.15)' : 'rgba(255,152,0,0.1)' }}
          >
            {isApproved ? (
              <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: '#4caf50' }} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
            ) : (
              <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: '#ff9800' }} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 15v-.75A.75.75 0 0 1 9 13.5h.75m0 0v-3m0 3h3m-3.75-9.75L14.25 3H9.75L8.25 5.25m7.5 0h-7.5m7.5 0v6.75m-7.5-6.75v6.75" />
              </svg>
            )}
          </div>
          <h1 className="text-[18px] font-bold mb-2" style={{ color: '#f1f5f9' }}>
            {isApproved ? 'Quote approved' : 'Changes requested'}
          </h1>
          <p className="text-[13px] leading-relaxed" style={{ color: '#94a3b8' }}>
            {isApproved
              ? 'Your builder has been notified and will get started on scheduling the work.'
              : 'Your builder has been notified and will follow up with you about the changes you requested.'}
          </p>
          <p className="text-[11px] mt-5 font-medium" style={{ color: '#ff6b2b' }}>Powered by WorkA</p>
        </div>
      </div>
    )
  }

  // ── Prompt overlay ──────────────────────────────────────────────────────────
  const promptOverlay = showPrompt && (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}>
      <div className="w-full max-w-sm rounded-2xl p-6" style={{ backgroundColor: '#1a1f2e', border: '0.5px solid rgba(255,255,255,0.08)' }}>
        <p className="text-[15px] font-semibold mb-1" style={{ color: '#f1f5f9' }}>
          {pendingAction === 'approved' ? 'Confirm your name' : 'What would you like changed?'}
        </p>
        <p className="text-[12px] mb-4" style={{ color: '#64748b' }}>
          {pendingAction === 'approved' ? 'This will be recorded on the quote approval.' : "Let your builder know what to update — they'll follow up directly."}
        </p>
        <input
          type="text"
          placeholder="Your name"
          value={clientName}
          onChange={e => setClientName(e.target.value)}
          autoFocus
          className="w-full rounded-lg px-3 py-2.5 text-[13px] outline-none mb-3"
          style={{ backgroundColor: '#0f1117', border: '0.5px solid rgba(255,255,255,0.12)', color: '#f1f5f9' }}
        />
        {pendingAction === 'changes_requested' && (
          <textarea
            placeholder="What would you like changed? (optional)"
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={3}
            className="w-full rounded-lg px-3 py-2.5 text-[13px] outline-none mb-4 resize-none"
            style={{ backgroundColor: '#0f1117', border: '0.5px solid rgba(255,255,255,0.12)', color: '#f1f5f9' }}
          />
        )}
        <div className={`flex gap-2 ${pendingAction === 'approved' ? 'mt-4' : ''}`}>
          <button
            type="button"
            onClick={() => setShowPrompt(false)}
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
              backgroundColor: pendingAction === 'approved' ? '#4caf50' : '#ff9800',
              color: '#fff',
            }}
          >
            {actionLoading ? 'Saving…' : pendingAction === 'approved' ? 'Confirm approval' : 'Send request'}
          </button>
        </div>
      </div>
    </div>
  )

  // ── Main view ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen px-4 py-10" style={{ backgroundColor: '#0f1117' }}>
      {promptOverlay}

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
            <p className="text-[11px] font-mono mb-1" style={{ color: '#ff6b2b' }}>QUOTE</p>
            <h1 className="text-[17px] font-bold mb-1" style={{ color: '#f1f5f9' }}>{quote.job_address}</h1>
            <p className="text-[12px]" style={{ color: '#64748b' }}>
              Hi {quote.client_name}{quote.sent_display ? ` · Sent ${quote.sent_display}` : ''}
            </p>
          </div>

          {/* Line items by category */}
          <div className="rounded-lg p-4 mb-5" style={{ backgroundColor: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.06)' }}>
            {quote.categories.map((cat, idx) => (
              <div key={cat.trade_category_id} className={idx > 0 ? 'mt-4 pt-4' : ''} style={idx > 0 ? { borderTop: '0.5px solid rgba(255,255,255,0.06)' } : undefined}>
                <p className="text-[12px] font-semibold mb-2" style={{ color: '#94a3b8' }}>{cat.trade_name}</p>
                {cat.items.map((item, i) => (
                  <div key={i} className="flex justify-between items-start gap-3 mb-1.5">
                    <span className="text-[12px] leading-snug" style={{ color: '#64748b' }}>{item.description}</span>
                    <span className="text-[12px] whitespace-nowrap" style={{ color: '#94a3b8' }}>{formatCurrency(item.client_price)}</span>
                  </div>
                ))}
              </div>
            ))}
            <div className="flex justify-between items-center pt-3 mt-3" style={{ borderTop: '0.5px solid rgba(255,255,255,0.08)' }}>
              <span className="text-[13px] font-semibold" style={{ color: '#f1f5f9' }}>Total</span>
              <span className="text-[15px] font-bold" style={{ color: '#ff6b2b' }}>{formatCurrency(quote.total)}</span>
            </div>
          </div>

          {/* Notice */}
          <p className="text-[11px] leading-relaxed mb-5" style={{ color: '#475569' }}>
            By approving this quote, you authorise your builder to proceed with the work described above at the total price shown.
          </p>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => handleAction('changes_requested')}
              disabled={actionLoading}
              className="flex-1 py-3 rounded-xl text-[14px] font-semibold disabled:opacity-50"
              style={{ backgroundColor: 'rgba(255,152,0,0.12)', color: '#ff9800', border: '0.5px solid rgba(255,152,0,0.3)' }}
            >
              Request changes
            </button>
            <button
              type="button"
              onClick={() => handleAction('approved')}
              disabled={actionLoading}
              className="flex-[2] py-3 rounded-xl text-[14px] font-semibold disabled:opacity-50"
              style={{ backgroundColor: '#4caf50', color: '#fff' }}
            >
              Accept — {formatCurrency(quote.total)}
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
