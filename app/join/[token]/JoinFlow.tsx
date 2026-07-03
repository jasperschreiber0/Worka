'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { DemoWorkerInvite } from '@/lib/worker-demo'

// ─── Types ────────────────────────────────────────────────────────────────────

interface JoinFlowProps {
  invite: DemoWorkerInvite
}

type Step = 'welcome' | 'phone' | 'done'

// ─── Step dots ────────────────────────────────────────────────────────────────

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className="rounded-full transition-all duration-300"
          style={{
            width: i === current ? '24px' : '8px',
            height: '8px',
            backgroundColor: i < current
              ? 'var(--orange-primary)'
              : i === current
              ? 'var(--orange-primary)'
              : 'var(--bg-border)',
            opacity: i < current ? 0.6 : 1,
          }}
        />
      ))}
    </div>
  )
}

// ─── Step 1: Welcome ──────────────────────────────────────────────────────────

function StepWelcome({
  invite,
  onNext,
}: {
  invite: DemoWorkerInvite
  onNext: (name: string) => void
}) {
  const [name, setName] = useState(invite.worker_name)

  return (
    <div className="flex flex-col flex-1">
      <StepDots current={0} total={3} />

      <div className="flex-1">
        <p style={{ color: 'var(--orange-primary)' }} className="text-xs font-semibold uppercase tracking-wide mb-2">
          You&apos;ve been invited
        </p>
        <h1 style={{ color: 'var(--text-primary)' }} className="text-2xl font-bold mb-2 leading-tight">
          Hi {invite.worker_name.split(' ')[0]}!
        </h1>
        <p style={{ color: 'var(--text-secondary)' }} className="text-sm leading-relaxed mb-6">
          <span style={{ color: 'var(--text-primary)' }} className="font-semibold">{invite.builder_name}</span> from{' '}
          {invite.builder_company} has added you to their WorkA crew as a{' '}
          <span style={{ color: 'var(--text-primary)' }} className="font-semibold">{invite.role}</span>.
        </p>

        {/* Job card */}
        <div
          style={{ backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--bg-border)' }}
          className="rounded-xl p-4 mb-8"
        >
          <p style={{ color: 'var(--text-secondary)' }} className="text-xs font-semibold uppercase tracking-wide mb-1">
            First job
          </p>
          <p style={{ color: 'var(--text-primary)' }} className="text-base font-bold">{invite.job_address}</p>
          <p style={{ color: 'var(--text-secondary)' }} className="text-sm">{invite.job_ref}</p>
        </div>

        <div className="mb-6">
          <label htmlFor="worker-name" style={{ color: 'var(--text-primary)' }} className="block text-sm font-medium mb-1">
            Confirm your name
          </label>
          <input
            id="worker-name"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input text-base"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={() => onNext(name.trim() || invite.worker_name)}
        disabled={!name.trim()}
        className="btn-primary w-full py-4 text-base rounded-2xl disabled:opacity-50"
      >
        That&apos;s me — continue
      </button>
    </div>
  )
}

// ─── Step 2: Phone ────────────────────────────────────────────────────────────

function StepPhone({ onNext }: { onNext: (phone: string) => void }) {
  const [phone, setPhone] = useState('')

  return (
    <div className="flex flex-col flex-1">
      <StepDots current={1} total={3} />

      <div className="flex-1">
        <h2 style={{ color: 'var(--text-primary)' }} className="text-2xl font-bold mb-2 leading-tight">
          Add your mobile
        </h2>
        <p style={{ color: 'var(--text-secondary)' }} className="text-sm leading-relaxed mb-8">
          Your builder can reach you when plans change on site. Optional — you can skip this.
        </p>

        <div className="mb-6">
          <label htmlFor="phone" style={{ color: 'var(--text-primary)' }} className="block text-sm font-medium mb-1">
            Mobile number
          </label>
          <input
            id="phone"
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="input text-base"
            placeholder="04XX XXX XXX"
          />
        </div>
      </div>

      <div className="space-y-3">
        <button
          type="button"
          onClick={() => onNext(phone.trim())}
          disabled={!phone.trim()}
          className="btn-primary w-full py-4 text-base rounded-2xl disabled:opacity-50"
        >
          Save number
        </button>
        <button
          type="button"
          onClick={() => onNext('')}
          className="w-full py-3 text-sm transition-opacity hover:opacity-70"
          style={{ color: 'var(--text-secondary)' }}
        >
          Skip for now
        </button>
      </div>
    </div>
  )
}

// ─── Step 3: Done ─────────────────────────────────────────────────────────────

function StepDone({ name, invite }: { name: string; invite: DemoWorkerInvite }) {
  const router = useRouter()
  const firstName = name.split(' ')[0]

  return (
    <div className="flex flex-col flex-1 items-center justify-center text-center">
      {/* Success icon */}
      <div
        className="w-20 h-20 rounded-full flex items-center justify-center mb-6"
        style={{ backgroundColor: 'rgba(76,175,80,0.15)' }}
      >
        <svg
          style={{ color: 'var(--status-green)' }}
          className="w-10 h-10"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>

      <h2 style={{ color: 'var(--text-primary)' }} className="text-2xl font-bold mb-2">
        You&apos;re in, {firstName}!
      </h2>
      <p style={{ color: 'var(--text-secondary)' }} className="text-sm leading-relaxed mb-2">
        Welcome to {invite.builder_company}&apos;s crew.
      </p>
      <p style={{ color: 'var(--text-secondary)' }} className="text-sm mb-10">
        Your first site is{' '}
        <span style={{ color: 'var(--text-primary)' }} className="font-semibold">{invite.job_address}</span>.
      </p>

      <button
        type="button"
        onClick={() => router.push('/worker')}
        className="btn-primary w-full py-4 text-base rounded-2xl"
      >
        Open my jobs
      </button>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function JoinFlow({ invite }: JoinFlowProps) {
  const [step, setStep] = useState<Step>('welcome')
  const [confirmedName, setConfirmedName] = useState(invite.worker_name)

  function handleWelcomeNext(name: string) {
    setConfirmedName(name)
    setStep('phone')
  }

  function handlePhoneNext(_phone: string) {
    setStep('done')
  }

  return (
    <div style={{ backgroundColor: 'var(--bg-shell)' }} className="min-h-screen flex flex-col px-6 pt-safe">
      {/* ── Logo bar ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 py-5 mb-6">
        <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center">
          <svg
            style={{ color: '#ffffff' }}
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21"
            />
          </svg>
        </div>
        <span style={{ color: 'var(--text-primary)' }} className="text-lg font-bold tracking-tight">WorkA</span>
      </div>

      {/* ── Step content ─────────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 pb-8 pb-safe max-w-sm w-full mx-auto">
        {step === 'welcome' && (
          <StepWelcome invite={invite} onNext={handleWelcomeNext} />
        )}
        {step === 'phone' && (
          <StepPhone onNext={handlePhoneNext} />
        )}
        {step === 'done' && (
          <StepDone name={confirmedName} invite={invite} />
        )}
      </div>
    </div>
  )
}
