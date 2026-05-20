import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Terms of Service — WorkA',
}

const SECTIONS = [
  {
    heading: 'Acceptance',
    body: `By creating a WorkA account or using the service, you agree to these Terms. If you do not agree, do not use WorkA.`,
  },
  {
    heading: 'The service',
    body: `WorkA is an AI-assisted operations management platform for Australian residential builders. It helps you draft quotes, manage jobs, track variations and invoices, and communicate with clients. WorkA is a tool — you remain responsible for all professional decisions, pricing, and communications sent to your clients.`,
  },
  {
    heading: 'Your responsibilities',
    body: `You are responsible for the accuracy of information you enter, for reviewing all AI-generated content before sending it to clients, and for complying with applicable laws including Australian Consumer Law, builder licensing requirements, and privacy obligations. WorkA does not provide legal, financial, or engineering advice.`,
  },
  {
    heading: 'Builder approval guarantee',
    body: `WorkA will never send a quote, invoice, variation, or client communication without your explicit approval. This is a core product guarantee. You must confirm each action before it reaches your client.`,
  },
  {
    heading: 'AI-generated content',
    body: `AI-generated quantities, rates, and draft communications are estimates and suggestions only. You must review and approve all AI output before use. WorkA makes no warranty that AI-generated content is accurate, complete, or fit for purpose.`,
  },
  {
    heading: 'Account',
    body: `You are responsible for maintaining the security of your account credentials. You must be a licensed builder or authorised representative to use WorkA for quoting purposes. One subscription per building business.`,
  },
  {
    heading: 'Acceptable use',
    body: `You may not use WorkA to submit false or misleading information, to harass clients or subcontractors, to reverse-engineer or copy the platform, or for any unlawful purpose. We may suspend accounts that violate these terms.`,
  },
  {
    heading: 'Subscription and billing',
    body: `WorkA subscriptions are billed monthly or annually via Stripe. You may cancel at any time; cancellation takes effect at the end of the billing period. No refunds are provided for partial periods. Prices are in AUD and include GST where applicable.`,
  },
  {
    heading: 'Intellectual property',
    body: `WorkA and its underlying software, design, and AI systems are owned by WorkA Pty Ltd. Your job data, quotes, and client information remain yours. You grant WorkA a limited licence to process your data to provide the service.`,
  },
  {
    heading: 'Limitation of liability',
    body: `To the maximum extent permitted by Australian law, WorkA's liability is limited to the fees you paid in the preceding 12 months. WorkA is not liable for loss of profit, loss of data, or consequential loss arising from use of the platform.`,
  },
  {
    heading: 'Governing law',
    body: `These Terms are governed by the laws of Victoria, Australia. Disputes will be resolved in the courts of Victoria.`,
  },
  {
    heading: 'Changes',
    body: `We may update these Terms. We will give you 14 days' notice of material changes via email. Continued use after changes constitutes acceptance.`,
  },
  {
    heading: 'Contact',
    body: `For questions about these Terms, email legal@worka.com.au.`,
  },
]

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-40 bg-white/90 backdrop-blur-sm border-b border-slate-100">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 no-underline">
            <div className="w-7 h-7 rounded-lg bg-brand-500 flex items-center justify-center">
              <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
              </svg>
            </div>
            <span className="text-base font-bold text-slate-900 tracking-tight">WorkA</span>
          </Link>
          <Link href="/" className="text-sm text-slate-500 hover:text-slate-700 transition-colors no-underline">
            ← Back
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-12">
        <p className="text-xs font-semibold text-brand-600 uppercase tracking-wide mb-3">Legal</p>
        <h1 className="text-3xl font-bold text-slate-900 mb-2">Terms of Service</h1>
        <p className="text-sm text-slate-400 mb-10">Last updated 20 May 2025 · WorkA (worka.com.au) · WorkA Pty Ltd ACN 000 000 000</p>

        <div className="prose prose-slate max-w-none space-y-8">
          {SECTIONS.map((s) => (
            <section key={s.heading}>
              <h2 className="text-base font-bold text-slate-900 mb-2">{s.heading}</h2>
              <p className="text-sm text-slate-600 leading-relaxed">{s.body}</p>
            </section>
          ))}
        </div>
      </main>

      <footer className="border-t border-slate-100 py-6 mt-12">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 flex items-center justify-between text-xs text-slate-400">
          <span>&copy; 2025 WorkA Pty Ltd</span>
          <Link href="/privacy" className="hover:text-slate-600 transition-colors no-underline">Privacy Policy</Link>
        </div>
      </footer>
    </div>
  )
}
