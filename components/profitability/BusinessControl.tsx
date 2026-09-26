'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  EMPTY_PROFILE,
  OVERHEAD_FIELDS,
  financialProfile,
  cashForecast,
  type FinancialProfile,
} from '@/lib/profitability'
import { Card, Field, Metrics, money, pct, api } from './ui'
import './profitability.css'
import ProfitControl from './ProfitControl'
import TodayActions from '@/components/jobs/TodayActions'
import CashFlowPlanner from './CashFlowPlanner'
const BUSINESS_VIEWS: Record<string, string> = { Overview: '#overview', 'Financial profile': '#financial-profile', '13-week cash flow': '#cash-flow' }
export default function BusinessControl() {
  const [profile, setProfile] = useState<FinancialProfile>(EMPTY_PROFILE),
    [jobs, setJobs] = useState<{ id: string; address: string; status: string }[]>([]),
    [demo, setDemo] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [tab, setTab] = useState('Overview'),
    [risk, setRisk] = useState<number | null>(null)
  useEffect(() => {
    const select = () => { setTab(Object.keys(BUSINESS_VIEWS).find(view => BUSINESS_VIEWS[view] === location.hash) ?? 'Overview') }
    select(); window.addEventListener('hashchange', select)
    return () => window.removeEventListener('hashchange', select)
  }, [])
  useEffect(() => {
    api('/api/business/financial-profile')
      .then((d) => {
        setProfile({ ...EMPTY_PROFILE, ...d.profile })
        setJobs(d.jobs)
        setDemo(d.demo)
        setRisk(
          (d.risks ?? [])
            .filter((r: { status: string }) => !['recovered', 'not_a_change'].includes(r.status))
            .reduce(
              (
                s: number,
                r: { estimated_cost: number | null; incurred: number; recovered: number },
              ) => s + Math.max(0, (r.estimated_cost ?? r.incurred) - r.recovered),
              0,
            ),
        )
        setLoaded(true)
      })
      .catch((e) => setError(e.message))
  }, [])
  const update = (key: keyof FinancialProfile, value: unknown) =>
    setProfile((p) => ({ ...p, [key]: value }))
  let calc: ReturnType<typeof financialProfile> | null = null,
    validation = ''
  try {
    calc = financialProfile(profile)
  } catch (e) {
    validation = (e as Error).message
  }
  async function save() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api(
        '/api/business/financial-profile',
        { profile },
        'PUT',
      )
      setNotice('Saved to your business')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="pi">
      <p className="muted">WORKA / BUSINESS</p>
      <h1>Builder control centre</h1>
      <p className="muted">Know whether the job will make money before you win it.</p>
      {error && (
        <div role="alert" className="pi-alert pi-error">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="pi-alert">
          {notice}
        </p>
      )}
      {demo && (
        <p className="pi-alert">
          Preview mode. Connect your business account to save figures and review real jobs.
        </p>
      )}
      {!loaded && !error && <p>Loading your business…</p>}
      <nav className="pi-tabs" aria-label="Business views">
        {['Overview', 'Financial profile', '13-week cash flow'].map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => { setTab(t); window.history.replaceState(null, '', BUSINESS_VIEWS[t]) }}>
            {t}
          </button>
        ))}
      </nav>
      {tab === 'Overview' && (
        <>
          <TodayActions />
          <ProfitControl />
          <div className="pi-hero">
            <Metrics
              values={[
                ['Revenue target', money(loaded?calc?.revenue:null)],
                ['Monthly overhead', money(loaded?calc?.monthlyOverhead:null)],
                ['Required gross margin', pct(calc?.targetMargin)],
                ['Known margin at risk', money(risk)],
              ]}
            />
            <p className="muted mt-4">
              Set your financial profile to calculate a sustainable margin. Risks are potential
              exposure, not confirmed losses; unpriced risks are additional.
            </p>
          </div>
          <Card title="Your jobs · profit and learning">
            <p className="muted mb-3">
              Your estimate said one thing. Your actuals said another. WorkA shows you why.
            </p>
            {!loaded ? <p>Job records have not finished loading.</p> : jobs.length === 0 ? (
              <p>
                No saved jobs yet. <Link href="/jobs?new=1">Create a job and upload plans →</Link>
              </p>
            ) : (
              <div className="pi-grid">
                {jobs.map((j) => (
                  <Link className="pi-card !mt-0" key={j.id} href={`/jobs/${j.id}/profitability`}>
                    <span className="pi-badge">{j.status}</span>
                    <h3 className="mt-3">{j.address}</h3>
                    <p>Review profitability →</p>
                  </Link>
                ))}
              </div>
            )}
          </Card>
          <Card title="Manage your business">
            <div className="flex flex-wrap gap-6">
              {[
                ['Jobs', '/jobs'],
                ['Team', '/team'],
                ['Suppliers', '/suppliers'],
                ['Variations', '/variations'],
                ['Settings', '/settings'],
              ].map(([label, href]) => (
                <Link key={href} href={href}>
                  {label} →
                </Link>
              ))}
            </div>
          </Card>
        </>
      )}
      {tab === 'Financial profile' && (
        <>
          <Card title="Business financial profile">
            <p className="muted">
              Annual amounts in AUD excluding GST. These planning assumptions do not change saved
              estimates.
            </p>
            <div className="pi-grid">
              <Field
                label="Annual revenue"
                value={profile.annualRevenue}
                onChange={(n) => update('annualRevenue', n)}
              />
              <Field
                label="Target annual revenue"
                value={profile.targetRevenue}
                onChange={(n) => update('targetRevenue', n)}
              />
              <Field
                nullable
                label="Expected jobs per year (optional)"
                value={profile.jobsPerYear}
                onChange={(n) => update('jobsPerYear', n)}
              />
              <Field
                label="Working weeks per year"
                value={profile.workingWeeks}
                onChange={(n) => update('workingWeeks', n)}
              />
              <Field
                nullable
                label="Annual construction volume, m² (optional)"
                value={profile.constructionVolume}
                onChange={(n) => update('constructionVolume', n)}
              />
            </div>
            <label className="pi-field">
              <span>Fixed overheads</span>
              <select
                value={profile.overheadMode}
                onChange={(e) => update('overheadMode', e.target.value)}
              >
                <option value="simple">Simple annual total</option>
                <option value="detailed">Detailed breakdown</option>
              </select>
            </label>
            {profile.overheadMode === 'simple' ? (
              <Field
                label="Annual overhead total"
                value={profile.annualOverhead}
                onChange={(n) => update('annualOverhead', n)}
              />
            ) : (
              <div className="pi-grid">
                {OVERHEAD_FIELDS.map((k) => (
                  <Field
                    key={k}
                    label={k}
                    value={profile.overheads[k] ?? 0}
                    onChange={(n) => update('overheads', { ...profile.overheads, [k]: n })}
                  />
                ))}
              </div>
            )}
            <label className="pi-field">
              <span>Profit target</span>
              <select
                value={profile.profitMode}
                onChange={(e) => update('profitMode', e.target.value)}
              >
                <option value="percent">Desired net profit percentage</option>
                <option value="amount">Annual profit amount</option>
              </select>
            </label>
            {profile.profitMode === 'percent' ? (
              <Field
                label="Desired net profit %"
                value={profile.netProfitPct}
                onChange={(n) => update('netProfitPct', n)}
              />
            ) : (
              <Field
                label="Annual profit target"
                value={profile.annualProfit}
                onChange={(n) => update('annualProfit', n)}
              />
            )}
            {validation && <p role="alert">{validation}</p>}
            <button
              className="primary"
              disabled={busy || !!validation || !loaded}
              onClick={save}
            >
              Save financial profile
            </button>
          </Card>
          {calc && (
            <Card title="What your business needs">
              <Metrics
                values={[
                  ['Annual overhead', money(calc.overhead)],
                  ['Weekly working overhead', money(calc.weeklyOverhead)],
                  ['Overhead / actual revenue', pct(calc.overheadPctOfActualRevenue)],
                  ['Minimum gross margin', pct(calc.minimumMargin)],
                  ['Target gross margin', pct(calc.targetMargin)],
                  ['Target annual profit', money(calc.targetProfit)],
                  ['Break-even revenue', money(calc.breakEvenRevenue)],
                ]}
              />
              <p className="muted mt-5">
                Minimum margin recovers overhead at your planning revenue of {money(calc.revenue)}.
                Target margin also covers your profit goal. Break-even revenue assumes work achieves
                this target gross margin. Weekly overhead uses {profile.workingWeeks} working weeks.
              </p>
              {!calc.viable && (
                <p className="pi-alert">
                  Enter a positive planning revenue and a sustainable overhead/profit target below
                  revenue to calculate viable prices.
                </p>
              )}
            </Card>
          )}
        </>
      )}
      <div hidden={tab !== '13-week cash flow'}><CashFlowPlanner /></div>
    </main>
  )
}
