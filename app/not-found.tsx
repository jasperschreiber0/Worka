import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 text-center" style={{ backgroundColor: 'var(--bg-shell)' }}>
      {/* Logo */}
      <Link href="/" className="flex items-center gap-2.5 mb-12 no-underline">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: 'var(--orange-primary)' }}>
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true" style={{ color: '#fff' }}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
          </svg>
        </div>
        <span className="text-2xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>WorkA</span>
      </Link>

      <p className="text-6xl font-bold mb-4" style={{ color: 'var(--bg-border)' }}>404</p>
      <h1 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Page not found</h1>
      <p className="text-sm max-w-xs mb-8 leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
        That page doesn&apos;t exist. It may have moved or the link might be wrong.
      </p>

      <div className="flex items-center gap-3">
        <Link href="/" className="btn-secondary no-underline text-sm">
          Go home
        </Link>
        <Link href="/chat" className="btn-primary no-underline text-sm">
          Open WorkA
        </Link>
      </div>
    </div>
  )
}
