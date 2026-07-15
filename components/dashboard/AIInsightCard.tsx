'use client'
import type { ReactNode } from 'react'

export interface AIInsightCardProps {
  icon: 'similar' | 'gap' | 'recency' | 'risk'
  text: string
  onClick?: () => void
}

const ICON_PATHS: Record<AIInsightCardProps['icon'], ReactNode> = {
  similar: <path strokeLinecap="round" strokeLinejoin="round" d="M9 3.75H4.5a.75.75 0 00-.75.75v4.5m16.5 0v-4.5a.75.75 0 00-.75-.75H15m0 16.5h4.5a.75.75 0 00.75-.75v-4.5M3.75 15v4.5c0 .414.336.75.75.75H9" />,
  gap: <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />,
  recency: <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />,
  risk: <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />,
}

export default function AIInsightCard({ icon, text, onClick }: AIInsightCardProps) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick() } : undefined}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '8px 10px',
        borderRadius: 6,
        border: '0.5px solid var(--bg-border)',
        backgroundColor: 'var(--bg-surface)',
        cursor: onClick ? 'pointer' : 'default',
        marginBottom: 6,
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--orange-primary)" strokeWidth={1.75} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}>
        {ICON_PATHS[icon]}
      </svg>
      <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>{text}</span>
    </div>
  )
}
