import type { Metadata } from 'next'

// ─── Types ────────────────────────────────────────────────────────────────────

interface JoinPageProps {
  params: Promise<{ token: string }>
}

// ─── Metadata ────────────────────────────────────────────────────────────────

export const metadata: Metadata = {
  title: 'Join WorkA',
  description: "You've been invited to join a WorkA crew.",
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function JoinPage({ params }: JoinPageProps) {
  const { token } = await params

  // In demo mode we just show the holding page.
  // In a live Supabase setup this is where we would look up the invite token
  // in the workers table and pre-fill the worker's name and builder's name.
  const isDemoToken = token === 'demo-invite-token' || !token

  // Placeholder builder name — a real implementation would query Supabase here.
  const builderName = isDemoToken ? 'your builder' : 'your builder'

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-4">
      {/* ── Logo ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2.5 mb-10">
        <div className="w-10 h-10 rounded-xl bg-brand-500 flex items-center justify-center flex-shrink-0">
          <svg
            className="w-5 h-5 text-white"
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
        <span className="text-2xl font-bold text-slate-900 tracking-tight">WorkA</span>
      </div>

      {/* ── Card ─────────────────────────────────────────────────────────── */}
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-md border border-slate-100 px-8 py-8 text-center">
        <h1 className="text-xl font-bold text-slate-900 mb-2">Hi there!</h1>
        <p className="text-slate-600 text-sm leading-relaxed mb-8">
          You&apos;ve been invited to join{' '}
          <span className="font-semibold text-slate-800">{builderName}&apos;s</span> WorkA crew.
        </p>

        {/* Disabled CTA */}
        <div className="relative group">
          <button
            disabled
            className="w-full py-3 px-4 rounded-xl bg-brand-500 text-white font-semibold text-sm opacity-60 cursor-not-allowed"
            aria-disabled="true"
          >
            Get started — it&apos;s free
          </button>
          {/* Tooltip */}
          <span className="absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap text-xs text-slate-500 bg-white border border-slate-200 rounded-lg px-3 py-1.5 shadow-sm pointer-events-none">
            Crew onboarding coming soon
          </span>
        </div>
      </div>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <p className="mt-16 text-xs text-slate-400 text-center">
        Powered by{' '}
        <span className="font-semibold text-slate-500">WorkA</span>
        {' '}— the AI operations manager for Australian builders.
      </p>
    </div>
  )
}
