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
export default function BusinessControl() {
  const [profile, setProfile] = useState<FinancialProfile>(EMPTY_PROFILE),
    [jobs, setJobs] = useState<{ id: string; address: string; status: string }[]>([]),
    [cash, setCash] = useState({
      opening: 0,
      weeks: Array.from({ length: 13 }, () => ({ inflow: 0, outflow: 0 })),
      complete: false,
      startOn: new Date().toISOString().slice(0, 10),
    }),
    [demo, setDemo] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [tab, setTab] = useState('Overview'),
    [risk, setRisk] = useState<number | null>(null)
  useEffect(() => {
    api('/api/business/financial-profile')
      .then((d) => {
        setProfile({ ...EMPTY_PROFILE, ...d.profile })
        setJobs(d.jobs)
        if (d.cash_flow?.weeks?.length === 13) setCash({ startOn: '', ...d.cash_flow })
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
  let forecast: ReturnType<typeof cashForecast> | null = null
  try {
    forecast = cashForecast(cash.opening, cash.weeks)
  } catch {}
  async function save(kind: 'profile' | 'cash_flow') {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api(
        '/api/business/financial-profile',
        kind === 'profile' ? { profile } : { cash_flow: cash },
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
          <button key={t} aria-selected={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {tab === 'Overview' && (
        <>
          <ProfitControl />
          <div className="pi-hero">
            <Metrics
              values={[
                ['Revenue target', money(calc?.revenue)],
                ['Monthly overhead', money(calc?.monthlyOverhead)],
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
            {jobs.length === 0 ? (
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
              onClick={() => save('profile')}
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
      {tab === '13-week cash flow' && (
        <Card title="13-week cash-flow forecast">
          <label className="pi-field"><span>Forecast starts on</span><input type="date" value={cash.startOn} onChange={e => setCash({ ...cash, startOn: e.target.value })} /></label>
          <p className="muted">
            Enter expected bank movements, including GST where applicable. Inflows can include
            claims, receivables and approved changes. Outflows should include suppliers,
            subcontractors, wages, overhead and major purchases. Add each amount once.
          </p>
          <Field
            label="Current cash"
            value={cash.opening}
            min={-999999999}
            onChange={(n) => setCash({ ...cash, opening: n ?? 0 })}
          />
          <div className="pi-scroll">
            <table>
              <thead>
                <tr>
                  <th>Week</th>
                  <th>Inflows</th>
                  <th>Outflows</th>
                  <th>Closing cash</th>
                </tr>
              </thead>
              <tbody>
                {cash.weeks.map((w, i) => (
                  <tr key={i}>
                    <td>Week {i + 1}{cash.startOn && <p className="muted">{new Date(Date.parse(cash.startOn) + i * 7 * 86400000).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</p>}</td>
                    <td>
                      <input
                        aria-label={`Week ${i + 1} inflows`}
                        type="number"
                        value={w.inflow}
                        onChange={(e) =>
                          setCash({
                            ...cash,
                            weeks: cash.weeks.map((r, j) =>
                              j === i ? { ...r, inflow: Number(e.target.value) } : r,
                            ),
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Week ${i + 1} outflows`}
                        type="number"
                        value={w.outflow}
                        onChange={(e) =>
                          setCash({
                            ...cash,
                            weeks: cash.weeks.map((r, j) =>
                              j === i ? { ...r, outflow: Number(e.target.value) } : r,
                            ),
                          })
                        }
                      />
                    </td>
                    <td className={(forecast?.rows[i].closing ?? 0) < 0 ? 'pi-bad' : ''}>
                      {money(forecast?.rows[i].closing)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="pi-check">
            <input
              type="checkbox"
              checked={cash.complete}
              onChange={(e) => setCash({ ...cash, complete: e.target.checked })}
            />
            I have included all known payments and receipts for these 13 weeks.
          </label>
          <p className="pi-alert">
            {cash.complete
              ? 'Based on your confirmed inputs; payment timing remains uncertain.'
              : 'Low confidence — inputs have not been confirmed complete.'}{' '}
            Lowest projected cash: {money(forecast?.lowest)} in Week {forecast?.lowestWeek}.{' '}
            {forecast?.deficitWeeks} deficit weeks. A profitable job can still create a cash
            shortfall.
          </p>
          <button
            className="primary"
            disabled={busy || !forecast || !cash.startOn}
            onClick={() => save('cash_flow')}
          >
            Save cash forecast
          </button>
        </Card>
      )}
    </main>
  )
}
