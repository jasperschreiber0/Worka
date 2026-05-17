export default function HomePage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-white px-4">
      {/* Logo mark */}
      <div className="mb-8 flex items-center gap-3">
        <div className="w-12 h-12 rounded-lg bg-brand-500 flex items-center justify-center">
          <svg
            className="w-7 h-7 text-white"
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
        <span className="text-3xl font-bold text-slate-900 tracking-tight">WorkA</span>
      </div>

      {/* Headline */}
      <h1 className="text-4xl sm:text-5xl font-bold text-slate-900 text-center leading-tight max-w-2xl">
        AI Operations Manager for{' '}
        <span className="text-brand-500">Australian Builders</span>
      </h1>

      {/* Tagline / value proposition */}
      <p className="mt-6 text-lg sm:text-xl text-slate-500 text-center max-w-xl leading-relaxed">
        Upload plans &rarr; AI-assisted draft quote &rarr; builder-approved &rarr; live job in one click
      </p>

      {/* Feature pills */}
      <div className="mt-10 flex flex-wrap justify-center gap-3">
        {[
          '13 trade categories',
          '5-tier rate hierarchy',
          'Morning brief AI',
          'Australian states',
          'Supabase realtime',
        ].map((feature) => (
          <span
            key={feature}
            className="inline-flex items-center rounded-full px-4 py-1.5 text-sm font-medium bg-brand-50 text-brand-700 border border-brand-200"
          >
            {feature}
          </span>
        ))}
      </div>

      {/* CTA placeholder — full auth UI comes in Session 3 */}
      <div className="mt-12 flex flex-col sm:flex-row gap-4 items-center">
        <button
          disabled
          className="btn-primary opacity-60 cursor-not-allowed px-8 py-3 text-base"
          title="Coming in Session 3"
        >
          Get started free
        </button>
        <p className="text-sm text-slate-400">Auth &amp; onboarding — Session 3</p>
      </div>

      {/* Build status */}
      <div className="mt-16 card px-6 py-4 text-sm text-slate-500 max-w-md w-full">
        <p className="font-semibold text-slate-700 mb-2">Build status</p>
        <ul className="space-y-1">
          <li className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            Session 1 — Scaffold &amp; schema &nbsp;
            <span className="text-green-600 font-medium">complete</span>
          </li>
          <li className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-slate-300" />
            Session 2 — Rate seeding (360+ items) &nbsp;
            <span className="text-slate-400">pending</span>
          </li>
          <li className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-slate-300" />
            Session 3 — Auth &amp; onboarding &nbsp;
            <span className="text-slate-400">pending</span>
          </li>
        </ul>
      </div>

      <footer className="mt-12 text-xs text-slate-400 text-center">
        &copy; {new Date().getFullYear()} WorkA &mdash; Built for Australian residential builders
      </footer>
    </main>
  )
}
