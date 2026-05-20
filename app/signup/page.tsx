'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import type { Database } from '@/lib/types/database.types'

export default function SignupPage() {
  const router = useRouter()
  const [fullName, setFullName] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      // Demo mode — no Supabase, just redirect
      if (!supabaseUrl) {
        router.push('/chat')
        return
      }

      const supabase = createClientComponentClient<Database>()
      const { error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
            company_name: companyName,
          },
        },
      })

      if (authError) {
        setError(authError.message)
        return
      }

      setDone(true)
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-md border border-slate-100 px-8 py-8 text-center">
          <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-slate-900 mb-2">Check your email</h1>
          <p className="text-sm text-slate-500 leading-relaxed mb-6">
            We sent a confirmation link to <span className="font-semibold text-slate-700">{email}</span>.
            Click it to activate your account.
          </p>
          <Link href="/login" className="btn-primary w-full py-2.5 text-sm no-underline inline-block text-center">
            Back to sign in
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-4">
      {/* ── Logo ─────────────────────────────────────────────────────────── */}
      <Link href="/" className="flex items-center gap-2.5 mb-10 no-underline">
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
      </Link>

      {/* ── Card ─────────────────────────────────────────────────────────── */}
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-md border border-slate-100 px-8 py-8">
        <h1 className="text-xl font-bold text-slate-900 mb-1">Create your account</h1>
        <p className="text-sm text-slate-500 mb-6">Free to start — no credit card needed.</p>

        {/* Demo banner */}
        {!supabaseUrl && (
          <div className="mb-5 bg-brand-50 border border-brand-200 rounded-lg px-4 py-3">
            <p className="text-xs font-semibold text-brand-700 mb-0.5">Demo mode</p>
            <p className="text-xs text-brand-600">
              Supabase not connected. Submitting will take you straight to the app.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="fullName" className="block text-sm font-medium text-slate-700 mb-1">
              Your name
            </label>
            <input
              id="fullName"
              type="text"
              autoComplete="name"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="input"
              placeholder="Dave Nguyen"
            />
          </div>

          <div>
            <label htmlFor="companyName" className="block text-sm font-medium text-slate-700 mb-1">
              Business name
            </label>
            <input
              id="companyName"
              type="text"
              autoComplete="organization"
              required
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="input"
              placeholder="Nguyen Constructions"
            />
          </div>

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
              placeholder="dave@nguyenconstructions.com.au"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
              placeholder="8+ characters"
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
            {loading ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-slate-500">
          Already have an account?{' '}
          <Link href="/login" className="font-semibold text-brand-600 hover:text-brand-700 no-underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
