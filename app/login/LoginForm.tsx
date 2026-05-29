'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import type { Database } from '@/lib/types/database.types'

const DEMO_EMAIL = 'demo@worka.com.au'
const DEMO_PASSWORD = 'demo1234'

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
        router.push(next as string)
        return
      }

      const supabase = createClientComponentClient<Database>()
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password })

      if (authError) {
        setError(authError.message)
        return
      }

      router.push(next as string)
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-4">
      {/* ── Logo ─────────────────────────────────────────────────────────── */}
      <Link href="/" className="flex items-center gap-2.5 mb-10 no-underline">
        <div className="w-10 h-10 rounded-xl bg-brand-500 flex items-center justify-center flex-shrink-0">
          <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
          </svg>
        </div>
        <span className="text-2xl font-bold text-slate-900 tracking-tight">WorkA</span>
      </Link>

      {/* ── Card ─────────────────────────────────────────────────────────── */}
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-md border border-slate-100 px-8 py-8">
        <h1 className="text-xl font-bold text-slate-900 mb-1">Sign in</h1>
        <p className="text-sm text-slate-500 mb-6">Welcome back — your jobs are waiting.</p>

        {/* Demo banner */}
        {!supabaseUrl && (
          <div className="mb-5 bg-brand-50 border border-brand-200 rounded-lg px-4 py-3">
            <p className="text-xs font-semibold text-brand-700 mb-0.5">Demo mode</p>
            <p className="text-xs text-brand-600">
              Use <span className="font-mono font-semibold">{DEMO_EMAIL}</span> /{' '}
              <span className="font-mono font-semibold">{DEMO_PASSWORD}</span> or any credentials to continue.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              placeholder="you@example.com.au"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full py-2.5 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-slate-500">
          No account?{' '}
          <Link href="/signup" className="font-semibold text-brand-600 hover:text-brand-700 no-underline">
            Sign up free
          </Link>
        </p>
      </div>
    </div>
  )
}
