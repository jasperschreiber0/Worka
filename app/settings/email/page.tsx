'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'

const DEMO_BUILDER_ID = '00000000-0000-0000-0000-000000000001'

// ─── Inner component that uses useSearchParams ────────────────────────────────

function EmailSettingsContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const connected = searchParams.get('connected')
  const [connecting, setConnecting] = useState<'gmail' | 'outlook' | null>(null)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [builderId, setBuilderId] = useState(DEMO_BUILDER_ID)

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return
    const supabase = createClientComponentClient()
    supabase.auth.getSession().then(({ data }) => {
      if (data.session?.user.id) setBuilderId(data.session.user.id)
    })
  }, [])

  useEffect(() => {
    // Clear query param from URL after reading it (keeps address bar clean)
    if (connected) {
      const timer = setTimeout(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        router.replace('/settings/email' as any, { scroll: false })
      }, 5000)
      return () => clearTimeout(timer)
    }
  }, [connected, router])

  async function handleConnect(provider: 'gmail' | 'outlook') {
    setConnecting(provider)
    try {
      const res = await fetch(
        `/api/email-sync/connect?provider=${provider}&builder_id=${builderId}`
      )
      const data = (await res.json()) as
        | { auth_url: string }
        | { demo_mode: true; message: string }

      if ('auth_url' in data) {
        window.location.href = data.auth_url
      } else {
        // Demo mode — simulate redirect to callback
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        router.push('/settings/email?connected=demo' as any)
      }
    } catch {
      setConnecting(null)
    }
  }

  const showSuccessBanner = !bannerDismissed && connected === 'true'
  const showDemoBanner = !bannerDismissed && connected === 'demo'

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-shell)' }}>
      {/* ── Header ────────────────────────────────────────────────────── */}
      <header style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--bg-border)' }}>
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-sm transition-colors"
            style={{ color: 'var(--text-secondary)' }}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back to WorkA
          </Link>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8">
        {/* ── Success banners ────────────────────────────────────────── */}
        {showSuccessBanner && (
          <div className="mb-6 flex items-start gap-3 rounded-xl px-4 py-3" style={{ background: 'rgba(76,175,80,0.15)', border: '1px solid rgba(76,175,80,0.3)' }}>
            <svg
              className="w-5 h-5 flex-shrink-0 mt-0.5"
              style={{ color: 'var(--status-green)' }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium" style={{ color: 'var(--status-green)' }}>
                Gmail connected — WorkA is now monitoring your inbox.
              </p>
            </div>
            <button
              onClick={() => setBannerDismissed(true)}
              className="flex-shrink-0 transition-colors"
              style={{ color: 'var(--status-green)' }}
              aria-label="Dismiss"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {showDemoBanner && (
          <div className="mb-6 flex items-start gap-3 rounded-xl px-4 py-3" style={{ background: 'rgba(255,152,0,0.1)', border: '1px solid rgba(255,152,0,0.2)' }}>
            <svg
              className="w-5 h-5 flex-shrink-0 mt-0.5"
              style={{ color: 'var(--status-amber)' }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium" style={{ color: 'var(--status-amber)' }}>
                Demo mode — connect OAuth credentials to enable real email sync.
              </p>
              <p className="mt-0.5 text-xs" style={{ color: 'var(--status-amber)' }}>
                See <code className="font-mono rounded px-1" style={{ background: 'rgba(255,152,0,0.15)' }}>.env.local.example</code> for setup instructions.
              </p>
            </div>
            <button
              onClick={() => setBannerDismissed(true)}
              className="flex-shrink-0 transition-colors"
              style={{ color: 'var(--status-amber)' }}
              aria-label="Dismiss"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* ── Page title ─────────────────────────────────────────────── */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Email sync</h1>
          <p className="mt-1.5" style={{ color: 'var(--text-secondary)' }}>
            Connect your inbox so WorkA can monitor job-related emails and draft responses.
          </p>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            WorkA only reads emails related to your active jobs. It never touches personal emails.
          </p>
        </div>

        {/* ── Connect section ────────────────────────────────────────── */}
        <section className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-tertiary)' }}>
            Connect your inbox
          </h2>
          <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)' }}>
            {/* Gmail */}
            <button
              onClick={() => handleConnect('gmail')}
              disabled={connecting !== null}
              className="w-full flex items-center gap-4 px-5 py-4 text-left transition-colors disabled:opacity-60 disabled:cursor-not-allowed group"
            >
              {/* Google G icon */}
              <span
                className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--bg-border)' }}
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    fill="#4285F4"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="#34A853"
                  />
                  <path
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    fill="#EA4335"
                  />
                </svg>
              </span>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Connect Gmail</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>Read-only access to job-related threads</p>
              </div>

              <span className="flex-shrink-0 transition-colors" style={{ color: 'var(--text-tertiary)' }}>
                {connecting === 'gmail' ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                )}
              </span>
            </button>

            {/* Outlook */}
            <button
              onClick={() => handleConnect('outlook')}
              disabled={connecting !== null}
              className="w-full flex items-center gap-4 px-5 py-4 text-left transition-colors disabled:opacity-60 disabled:cursor-not-allowed group"
              style={{ borderTop: '1px solid var(--bg-border)' }}
            >
              {/* Microsoft icon */}
              <span
                className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--bg-border)' }}
              >
                <svg className="w-5 h-5" viewBox="0 0 23 23" aria-hidden="true">
                  <rect x="1" y="1" width="10" height="10" fill="#f25022" />
                  <rect x="12" y="1" width="10" height="10" fill="#7fba00" />
                  <rect x="1" y="12" width="10" height="10" fill="#00a4ef" />
                  <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
                </svg>
              </span>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Connect Outlook</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>Microsoft 365 and Outlook.com</p>
              </div>

              <span className="flex-shrink-0 transition-colors" style={{ color: 'var(--text-tertiary)' }}>
                {connecting === 'outlook' ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                )}
              </span>
            </button>
          </div>
        </section>

        {/* ── What WorkA monitors ────────────────────────────────────── */}
        <section className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-tertiary)' }}>
            What WorkA monitors
          </h2>
          <div className="rounded-xl px-5 py-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)' }}>
            <ul className="space-y-2.5">
              {[
                'Client replies to quotes',
                'Client replies to variations',
                'Invoice payment confirmations',
                'Emails mentioning your job sites',
                'New quote requests',
              ].map((item) => (
                <li key={item} className="flex items-center gap-3 text-sm" style={{ color: 'var(--text-primary)' }}>
                  <span className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: 'rgba(76,175,80,0.15)' }}>
                    <svg
                      className="w-3 h-3"
                      style={{ color: 'var(--status-green)' }}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </span>
                  {item}
                </li>
              ))}

              <li className="pt-1" style={{ borderTop: '1px solid var(--bg-border)' }} />

              {[
                'Personal emails',
                'Newsletters and marketing',
                'Emails older than 90 days',
              ].map((item) => (
                <li key={item} className="flex items-center gap-3 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                  <span className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: 'var(--bg-elevated)' }}>
                    <svg
                      className="w-3 h-3"
                      style={{ color: 'var(--text-tertiary)' }}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── Approval notice ────────────────────────────────────────── */}
        <div className="rounded-xl px-5 py-4" style={{ background: 'var(--bg-elevated)' }}>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>WorkA never sends without your approval.</span>{' '}
            Every reply is drafted for your review first. You stay in control of every communication.
          </p>
        </div>
      </main>
    </div>
  )
}

// ─── Page component (Suspense boundary for useSearchParams) ──────────────────

export default function EmailSettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-shell)' }}>
          <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Loading…</div>
        </div>
      }
    >
      <EmailSettingsContent />
    </Suspense>
  )
}
