import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Privacy Policy — WorkA',
}

const SECTIONS = [
  {
    heading: 'What we collect',
    body: `WorkA collects information you provide directly — your name, email address, business name, and any job or quote data you enter. When you connect Gmail or Outlook, we request read-only access to emails related to your active jobs. We never read personal emails.`,
  },
  {
    heading: 'How we use it',
    body: `Your data is used solely to provide the WorkA service: drafting quotes, surfacing job alerts, drafting emails for your review, and syncing relevant client communications. We never sell your data or use it for advertising.`,
  },
  {
    heading: 'AI processing',
    body: `WorkA uses Anthropic's Claude AI to classify messages, extract quantities from plans, and draft communications. Your job data may be sent to Anthropic's API for processing. Anthropic's data handling is governed by their privacy policy. WorkA does not train AI models on your data.`,
  },
  {
    heading: 'Builder approval',
    body: `WorkA never sends emails, quotes, invoices, or variations to your clients without your explicit approval. Every action that reaches a client requires you to tap "Send" or "Confirm". This is a non-negotiable product guarantee.`,
  },
  {
    heading: 'Data storage',
    body: `Your data is stored in Supabase (Postgres) hosted on AWS in Australia (ap-southeast-2). Row-level security ensures your data is never accessible to other builders on the platform.`,
  },
  {
    heading: 'Data retention',
    body: `Your data is retained for as long as your account is active. You may request deletion at any time by emailing privacy@worka.com.au. We will delete your data within 30 days, except where retention is required by Australian law.`,
  },
  {
    heading: 'Third-party services',
    body: `WorkA uses: Supabase (database), Anthropic (AI), Resend (email delivery), Twilio (optional SMS), Stripe (billing), and Google/Microsoft OAuth (email sync). Each service is bound by their own privacy policy.`,
  },
  {
    heading: 'Your rights',
    body: `Under the Australian Privacy Act 1988, you have the right to access, correct, and delete your personal information. Contact privacy@worka.com.au for any privacy requests.`,
  },
  {
    heading: 'Changes',
    body: `We may update this policy from time to time. We will notify you of material changes via email and in-app notice. Continued use of WorkA after changes constitutes acceptance of the updated policy.`,
  },
  {
    heading: 'Contact',
    body: `For privacy questions, contact privacy@worka.com.au. For general support, use the in-app chat or email support@worka.com.au.`,
  },
]

export default function PrivacyPage() {
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
        <h1 className="text-3xl font-bold text-slate-900 mb-2">Privacy Policy</h1>
        <p className="text-sm text-slate-400 mb-10">Last updated 20 May 2025 · Applies to WorkA (worka.com.au)</p>

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
          <span>&copy; 2025 WorkA</span>
          <Link href="/terms" className="hover:text-slate-600 transition-colors no-underline">Terms of Service</Link>
        </div>
      </footer>
    </div>
  )
}
