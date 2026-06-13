'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import type { Database } from '@/lib/types/database.types'

const DEMO_EMAIL = 'demo@worka.com.au'
const DEMO_PASSWORD = 'demo1234'

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  backgroundColor: 'var(--bg-elevated)',
  border: '0.5px solid var(--bg-border)',
  color: 'var(--text-primary)',
  borderRadius: 6,
  padding: '10px 12px',
  fontSize: 13,
  outline: 'none',
}

export default function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const next = searchParams.get('next') ?? '/chat'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      if (!supabaseUrl || (email === DEMO_EMAIL && password === DEMO_PASSWORD)) {
        router.push(next as never)
        return
      }

      const supabase = createClientComponentClient<Database>()
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password })

      if (authError) {
        setError(authError.message)
        return
      }

      router.push(next as never)
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4" style={{ backgroundColor: 'var(--bg-shell)' }}>
      {/* Logo */}
      <Link href="/" className="flex items-center gap-2.5 mb-10 no-underline">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: 'var(--orange-primary)' }}>
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            style={{ color: '#fff' }} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
          </svg>
        </div>
        <span className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>WorkA</span>
      </Link>

      {/* Card */}
      <div className="w-full max-w-sm rounded-[10px] px-8 py-8"
        style={{ backgroundColor: 'var(--bg-surface)', border: '0.5px solid var(--bg-border)' }}>
        <h1 className="text-[18px] font-bold mb-1" style={{ color: 'var(--text-primary)' }}>Sign in</h1>
        <p className="text-[13px] mb-6" style={{ color: 'var(--text-tertiary)' }}>Welcome back — your jobs are waiting.</p>

        {/* Demo banner */}
        {!supabaseUrl && (
          <div className="mb-5 rounded-[6px] px-3 py-2.5"
            style={{ backgroundColor: 'rgba(255,107,43,0.1)', border: '0.5px solid rgba(255,107,43,0.3)' }}>
            <p className="text-[11px] font-semibold mb-0.5" style={{ color: 'var(--orange-primary)' }}>Demo mode</p>
            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              Use <span className="font-mono font-semibold">{DEMO_EMAIL}</span> /{' '}
              <span className="font-mono font-semibold">{DEMO_PASSWORD}</span> or any credentials to continue.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-[12px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={INPUT_STYLE}
              placeholder="you@example.com.au"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-[12px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={INPUT_STYLE}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-[12px] rounded-[4px] px-3 py-2"
              style={{ color: 'var(--status-red)', backgroundColor: 'rgba(244,67,54,0.1)', border: '0.5px solid rgba(244,67,54,0.3)' }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 text-[13px] font-semibold rounded-[6px] disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ backgroundColor: 'var(--orange-primary)', color: '#fff' }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-5 text-center text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          No account?{' '}
          <Link href="/signup" className="font-semibold no-underline" style={{ color: 'var(--orange-primary)' }}>
            Sign up free
          </Link>
        </p>
      </div>
    </div>
  )
}
