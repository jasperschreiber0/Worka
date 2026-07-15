'use client'
import type { TimelineStep } from '@/lib/job-snapshot-demo'

export interface TimelineProps {
  steps: TimelineStep[]
}

export default function Timeline({ steps }: TimelineProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {steps.map((step, idx) => (
        <div key={step.label} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, position: 'relative' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                backgroundColor: step.done ? 'var(--status-green)' : step.current ? 'var(--orange-primary)' : 'transparent',
                border: step.done || step.current ? 'none' : '1px solid var(--bg-border)',
              }}
            >
              {step.done && (
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={3} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
            {idx < steps.length - 1 && (
              <div style={{ width: 1, flex: 1, minHeight: 20, backgroundColor: step.done ? 'var(--status-green)' : 'var(--bg-border)', opacity: step.done ? 0.4 : 1 }} />
            )}
          </div>
          <div style={{ paddingBottom: idx < steps.length - 1 ? 14 : 0, minWidth: 0 }}>
            <span
              style={{
                fontSize: 12,
                fontWeight: step.current ? 600 : 500,
                color: step.done ? 'var(--text-secondary)' : step.current ? 'var(--text-primary)' : 'var(--text-tertiary)',
              }}
            >
              {step.label}
            </span>
            {step.current && (
              <span style={{ display: 'block', fontSize: 10, color: 'var(--orange-primary)', marginTop: 1 }}>In progress</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
