'use client'
import React from 'react'

// ─── IndicativeBanner ─────────────────────────────────────────────────────────
// The visible "Indicative / Budget-Range Only" watermark. Per the estimating
// brief this must be a header/banner on every output when the clarifying step is
// skipped or essential gaps remain — never a footnote. Reused by the assessment
// view and (Stage 5) the Excel/PDF/client-quote exports.

interface Props {
  /** why it's indicative — shown as the sub-line */
  reason?: string
  compact?: boolean
}

export default function IndicativeBanner({ reason, compact }: Props) {
  return (
    <div
      role="note"
      className="rounded-xl flex items-start gap-3"
      style={{
        background: 'rgba(255,152,0,0.1)',
        border: '1px solid var(--status-amber)',
        padding: compact ? '10px 14px' : '14px 16px',
      }}
    >
      <svg
        className="flex-shrink-0"
        style={{ width: 18, height: 18, color: 'var(--status-amber)', marginTop: 1 }}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
      <div className="min-w-0">
        <p
          className="font-bold uppercase"
          style={{ color: 'var(--status-amber)', fontSize: compact ? 12 : 13, letterSpacing: '.04em' }}
        >
          Indicative / Budget-Range Only
        </p>
        <p className="mt-0.5" style={{ color: 'var(--text-secondary)', fontSize: compact ? 11 : 12.5, lineHeight: 1.45 }}>
          {reason ??
            'Not tender-ready. Firm pricing requires the missing documents and selections to be resolved first.'}
        </p>
      </div>
    </div>
  )
}
