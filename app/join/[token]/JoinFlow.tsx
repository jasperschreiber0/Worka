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
          className={`rounded-full transition-all duration-300 ${
            i < current
              ? 'w-2 h-2 bg-brand-400'
              : i === current
              ? 'w-6 h-2 bg-brand-500'
              : 'w-2 h-2 bg-slate-200'
          }`}
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
        <p className="text-xs font-semibold text-brand-600 uppercase tracking-wide mb-2">
          You&apos;ve been invited
        </p>
        <h1 className="text-2xl font-bold text-slate-900 mb-2 leading-tight">
          Hi {invite.worker_name.split(' ')[0]}!
        </h1>
        <p className="text-slate-500 text-sm leading-relaxed mb-6">
          <span className="font-semibold text-slate-700">{invite.builder_name}</span> from{' '}
          {invite.builder_company} has added you to their WorkA crew as a{' '}
          <span className="font-semibold text-slate-700">{invite.role}</span>.
        </p>

        {/* Job card */}
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-8">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
            First job
          </p>
          <p className="text-base font-bold text-slate-900">{invite.job_address}</p>
          <p className="text-sm text-slate-500">{invite.job_ref}</p>
        </div>

        <div className="mb-6">
          <label htmlFor="worker-name" className="block text-sm font-medium text-slate-700 mb-1">
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
        <h2 className="text-2xl font-bold text-slate-900 mb-2 leading-tight">
          Add your mobile
        </h2>
        <p className="text-slate-500 text-sm leading-relaxed mb-8">
          Your builder can reach you when plans change on site. Optional — you can skip this.
        </p>

        <div className="mb-6">
          <label htmlFor="phone" className="block text-sm font-medium text-slate-700 mb-1">
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
          className="w-full py-3 text-sm text-slate-500 hover:text-slate-700 transition-colors"
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
      <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center mb-6">
        <svg
          className="w-10 h-10 text-green-600"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>

      <h2 className="text-2xl font-bold text-slate-900 mb-2">
        You&apos;re in, {firstName}!
      </h2>
      <p className="text-slate-500 text-sm leading-relaxed mb-2">
        Welcome to {invite.builder_company}&apos;s crew.
      </p>
      <p className="text-slate-400 text-sm mb-10">
        Your first site is{' '}
        <span className="font-semibold text-slate-600">{invite.job_address}</span>.
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
    <div className="min-h-screen bg-white flex flex-col px-6 pt-safe">
      {/* ── Logo bar ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 py-5 mb-6">
        <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center">
          <svg
            className="w-4 h-4 text-white"
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
        <span className="text-lg font-bold text-slate-900 tracking-tight">WorkA</span>
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
