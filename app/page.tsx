import Link from 'next/link'
import HeroUploadZone from '@/components/home/HeroUploadZone'
import QuotesPipeline from '@/components/home/QuotesPipeline'

// ─── Page ─────────────────────────────────────────────────────────────────────

export const metadata = {
  title: 'WorkA — AI Operations Manager for Australian Builders',
  description:
    'Upload plans and get a builder-ready draft quote in minutes. Built for Australian residential builders.',
}

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* ── Nav ──────────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 bg-white/90 backdrop-blur-sm border-b border-slate-100">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-md bg-brand-500 flex items-center justify-center flex-shrink-0">
              <svg
                className="w-4.5 h-4.5 text-white"
                style={{ width: '1.125rem', height: '1.125rem' }}
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
            <span className="text-xl font-bold text-slate-900 tracking-tight">WorkA</span>
          </div>

          {/* CTA */}
          <Link href="/jobs" className="btn-primary px-4 py-2 text-sm no-underline">
            Open WorkA →
          </Link>
        </div>
      </header>

      {/* ── Section 1: Hero ───────────────────────────────────────────────────── */}
      <section className="py-16 sm:py-24">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          {/* Eyebrow */}
          <p className="text-sm font-semibold text-brand-600 tracking-wide uppercase mb-4">
            Built for Australian residential builders
          </p>

          {/* Headline */}
          <h1 className="text-5xl sm:text-6xl font-bold text-slate-900 leading-tight max-w-2xl">
            The AI operations manager for builders
          </h1>

          {/* Subheadline */}
          <p className="mt-5 text-xl text-slate-500 max-w-xl leading-relaxed">
            Upload plans. Get a quote in minutes.{' '}
            <span className="text-slate-700 font-medium">
              You review everything before it goes anywhere.
            </span>
          </p>

          {/* Upload zone */}
          <div className="mt-10 max-w-xl">
            <HeroUploadZone />
            <p className="mt-3 text-sm text-slate-400 text-center">
              No account needed to see a sample quote.
            </p>
          </div>
        </div>
      </section>

      {/* ── Section 2: Value statements ───────────────────────────────────────── */}
      <section className="py-16 sm:py-20 bg-slate-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Card 1 */}
            <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
              <div className="w-10 h-10 rounded-lg bg-brand-50 border border-brand-200 flex items-center justify-center mb-4">
                <svg
                  className="w-5 h-5 text-brand-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-slate-900 mb-2">Quote in minutes</h2>
              <p className="text-sm text-slate-500 leading-relaxed">
                Upload plans. AI extracts quantities across 13 trade categories. Your rates applied automatically.
              </p>
            </div>

            {/* Card 2 */}
            <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
              <div className="w-10 h-10 rounded-lg bg-brand-50 border border-brand-200 flex items-center justify-center mb-4">
                <svg
                  className="w-5 h-5 text-brand-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-slate-900 mb-2">You approve everything</h2>
              <p className="text-sm text-slate-500 leading-relaxed">
                WorkA drafts. You sign off before it reaches your client. Always. Nothing goes out without your tap.
              </p>
            </div>

            {/* Card 3 */}
            <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
              <div className="w-10 h-10 rounded-lg bg-brand-50 border border-brand-200 flex items-center justify-center mb-4">
                <svg
                  className="w-5 h-5 text-brand-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-slate-900 mb-2">Full job in one click</h2>
              <p className="text-sm text-slate-500 leading-relaxed">
                Quote → variations → invoices → audit trail. All in one place. Activate a job the moment your client says yes.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Section 3: Pipeline visualization ────────────────────────────────── */}
      <section className="py-16 sm:py-20">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-10 text-center">
            From plans to paid — in one tool
          </h2>

          {/* Horizontal flow */}
          <div className="flex flex-col md:flex-row items-stretch gap-0">
            {[
              {
                step: '01',
                title: 'Upload plans',
                sub: 'PDF, DWG, or photos',
              },
              {
                step: '02',
                title: 'AI draft quote',
                sub: '13 categories extracted',
                callout: '13 trade categories',
              },
              {
                step: '03',
                title: 'You review',
                sub: 'Confidence-scored items',
                callout: 'Confidence scored',
              },
              {
                step: '04',
                title: 'Send to client',
                sub: 'One tap when ready',
                callout: 'One-tap send',
              },
              {
                step: '05',
                title: 'Live job',
                sub: 'Milestones, invoices, comms',
              },
            ].map((item, i, arr) => (
              <div key={item.step} className="flex md:flex-col items-center md:flex-1">
                {/* Step card */}
                <div className="flex-1 md:flex-none flex flex-col items-center text-center px-2 py-4">
                  <span className="text-xs font-bold text-brand-500 mb-1">{item.step}</span>
                  <span className="text-sm font-bold text-slate-900">{item.title}</span>
                  <span className="text-xs text-slate-400 mt-0.5">{item.sub}</span>
                </div>

                {/* Arrow */}
                {i < arr.length - 1 && (
                  <div className="flex items-center justify-center px-1 md:px-2 text-slate-300 font-bold text-lg select-none md:rotate-0 rotate-90">
                    →
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Callout labels — desktop only */}
          <div className="hidden md:flex mt-2 px-0">
            {[
              { label: '' },
              { label: '13 categories extracted', offset: 'flex-1 text-center' },
              { label: 'Confidence scored', offset: 'flex-1 text-center' },
              { label: 'One-tap activation', offset: 'flex-1 text-center' },
              { label: '' },
            ].map((c, i) => (
              <div key={i} className={`flex-1 text-center`}>
                {c.label && (
                  <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                    <span className="text-brand-400">↑</span> {c.label}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Section 4: Quotes pipeline ────────────────────────────────────────── */}
      <section className="py-16 sm:py-20 bg-slate-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-900">
              Your quotes pipeline
            </h2>
            <Link href="/jobs" className="btn-secondary text-sm no-underline">
              Open WorkA →
            </Link>
          </div>
          <QuotesPipeline />
          <p className="mt-4 text-sm text-slate-400">
            Live demo data — tap any job to open it in WorkA.
          </p>
        </div>
      </section>

      {/* ── Section 5: Built for builders copy + CTA ─────────────────────────── */}
      <section className="py-16 sm:py-24">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-6">
              Built for builders, not accountants
            </h2>
            <p className="text-lg text-slate-500 mb-8">
              Three questions every builder needs answered:
            </p>

            <ul className="space-y-4 mb-10">
              {[
                'Which job is bleeding margin?',
                "What's outstanding from the client?",
                'What did I agree to on that variation?',
              ].map((q) => (
                <li key={q} className="flex items-start gap-3">
                  <span className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-brand-500 flex items-center justify-center">
                    <svg
                      className="w-3 h-3 text-white"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                  </span>
                  <span className="text-base text-slate-700">{q}</span>
                </li>
              ))}
            </ul>

            <p className="text-lg font-semibold text-slate-900 mb-8">
              WorkA knows. You ask. It answers.
            </p>

            <Link
              href="/jobs?action=new_quote"
              className="btn-primary px-8 py-3 text-base no-underline"
            >
              Start with your next quote →
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────────── */}
      <footer className="border-t border-slate-100 py-8">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-slate-400">
          <span>&copy; 2025 WorkA — Built for Australian residential builders</span>
          <div className="flex items-center gap-4">
            <a href="/privacy" className="hover:text-slate-600 transition-colors">
              Privacy
            </a>
            <a href="/terms" className="hover:text-slate-600 transition-colors">
              Terms
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
