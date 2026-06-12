'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import type { Database } from '@/lib/types/database.types'

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
      <div className="min-h-screen flex flex-col items-center justify-center px-4" style={{ backgroundColor: 'var(--bg-shell)' }}>
        <div className="w-full max-w-sm rounded-[10px] px-8 py-8 text-center"
          style={{ backgroundColor: 'var(--bg-surface)', border: '0.5px solid var(--bg-border)' }}>
          <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4"
            style={{ backgroundColor: 'rgba(76,175,80,0.15)' }}>
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              style={{ color: 'var(--status-green)' }} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
          </div>
          <h1 className="text-[18px] font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Check your email</h1>
          <p className="text-[13px] leading-relaxed mb-6" style={{ color: 'var(--text-tertiary)' }}>
            We sent a confirmation link to <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>{email}</span>.
            Click it to activate your account.
          </p>
          <Link href="/login"
            className="w-full py-2.5 text-[13px] font-semibold rounded-[6px] no-underline inline-block text-center"
            style={{ backgroundColor: 'var(--orange-primary)', color: '#fff' }}>
            Back to sign in
          </Link>
        </div>
      </div>
    )
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
        <h1 className="text-[18px] font-bold mb-1" style={{ color: 'var(--text-primary)' }}>Create your account</h1>
        <p className="text-[13px] mb-6" style={{ color: 'var(--text-tertiary)' }}>Free to start — no credit card needed.</p>

        {/* Demo banner */}
        {!supabaseUrl && (
          <div className="mb-5 rounded-[6px] px-3 py-2.5"
            style={{ backgroundColor: 'rgba(255,107,43,0.1)', border: '0.5px solid rgba(255,107,43,0.3)' }}>
            <p className="text-[11px] font-semibold mb-0.5" style={{ color: 'var(--orange-primary)' }}>Demo mode</p>
            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              Supabase not connected. Submitting will take you straight to the app.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {[
            { id: 'fullName', label: 'Your name', type: 'text', autoComplete: 'name', value: fullName, onChange: setFullName, placeholder: 'Dave Nguyen' },
            { id: 'companyName', label: 'Business name', type: 'text', autoComplete: 'organization', value: companyName, onChange: setCompanyName, placeholder: 'Nguyen Constructions' },
            { id: 'email', label: 'Email', type: 'email', autoComplete: 'email', value: email, onChange: setEmail, placeholder: 'dave@nguyenconstructions.com.au' },
          ].map(({ id, label, type, autoComplete, value, onChange, placeholder }) => (
            <div key={id}>
              <label htmlFor={id} className="block text-[12px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{label}</label>
              <input id={id} type={type} autoComplete={autoComplete} required value={value}
                onChange={(e) => onChange(e.target.value)} style={INPUT_STYLE} placeholder={placeholder} />
            </div>
          ))}

          <div>
            <label htmlFor="password" className="block text-[12px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Password</label>
            <input id="password" type="password" autoComplete="new-password" required minLength={8}
              value={password} onChange={(e) => setPassword(e.target.value)}
              style={INPUT_STYLE} placeholder="8+ characters" />
          </div>

          {error && (
            <p className="text-[12px] rounded-[4px] px-3 py-2"
              style={{ color: 'var(--status-red)', backgroundColor: 'rgba(244,67,54,0.1)', border: '0.5px solid rgba(244,67,54,0.3)' }}>
              {error}
            </p>
          )}

          <button type="submit" disabled={loading}
            className="w-full py-2.5 text-[13px] font-semibold rounded-[6px] disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ backgroundColor: 'var(--orange-primary)', color: '#fff' }}>
            {loading ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="mt-5 text-center text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          Already have an account?{' '}
          <Link href="/login" className="font-semibold no-underline" style={{ color: 'var(--orange-primary)' }}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
