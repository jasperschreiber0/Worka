'use client'
import { motion } from 'framer-motion'
import type { JobBucket } from '@/lib/job-attention'

export interface JobFeedCardItem {
  job_id: string
  address: string
  client_name: string | null
  estimated_value: number | null
  last_activity: string
  status: string
  bucket: JobBucket
  ai_reasoning: string
  primary_action: string
  secondary_action?: string
}

export interface JobCardProps {
  item: JobFeedCardItem
  onOpen: (jobId: string) => void
  onPrimaryAction: (item: JobFeedCardItem) => void
  onSecondaryAction?: (item: JobFeedCardItem) => void
}

function formatAUD(amount: number | null): string {
  if (amount == null) return '—'
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(amount)
}

const BUCKET_ACCENT: Record<JobBucket, string> = {
  overdue: 'var(--status-red)',
  due_today: 'var(--status-amber)',
  waiting_client: 'var(--status-amber)',
  waiting_supplier: 'var(--status-blue)',
  ready_invoice: 'var(--status-green)',
}

export default function JobCard({ item, onOpen, onPrimaryAction, onSecondaryAction }: JobCardProps) {
  const accent = BUCKET_ACCENT[item.bucket]

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item.job_id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen(item.job_id) }}
      style={{
        borderRadius: 10,
        border: '0.5px solid var(--bg-border)',
        borderLeft: `3px solid ${accent}`,
        backgroundColor: 'var(--bg-surface)',
        padding: '14px 16px',
        marginBottom: 10,
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>
            {item.address.split(',')[0]}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
            {[item.client_name, item.last_activity].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{formatAUD(item.estimated_value)}</div>
        </div>
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: 10 }}>
        {item.ai_reasoning}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onPrimaryAction(item) }}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: 'none',
            backgroundColor: 'var(--orange-primary)',
            color: '#fff',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {item.primary_action}
        </button>
        {item.secondary_action && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onSecondaryAction ? onSecondaryAction(item) : onOpen(item.job_id) }}
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '0.5px solid var(--bg-border)',
              backgroundColor: 'transparent',
              color: 'var(--text-secondary)',
              fontSize: 12.5,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {item.secondary_action}
          </button>
        )}
      </div>
    </motion.div>
  )
}
