'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import type { loadIntelligence } from '@/lib/profitability-data'
import { financialProfile, marginGate, waterfallLayout, type Candidate } from '@/lib/profitability'
import { TRADE_CATEGORIES, tradeCategoryName } from '@/lib/trade-taxonomy'
import { Card, Field, TextField, Metrics, api, money, pct } from './ui'
import CostImport from './CostImport'
import JobControl from './JobControl'
import FinancialCorrections from './FinancialCorrections'
import './profitability.css'
type Data = Awaited<ReturnType<typeof loadIntelligence>>
const tradeName = (id: number | null) => (id === null ? 'Unclassified' : tradeCategoryName(id))
function CandidateEditor({
  candidate,
  onSave,
  onVariation,
  busy,
}: {
  candidate: Candidate
  onSave: (v: unknown) => void
  onVariation: () => void
  busy: boolean
}) {
  const [v, setV] = useState(candidate)
  useEffect(() => setV(candidate), [candidate])
  return (
    <details>
      <summary>
        <span className="pi-badge">{candidate.status.replaceAll('_', ' ')}</span> {candidate.title}{' '}
        · {candidate.estimated_cost === null ? 'Cost unknown' : money(candidate.estimated_cost)}
      </summary>
      <p className="muted mt-3">Source: “{candidate.evidence}”</p>
      <p className="muted">
        Original scope: {candidate.original_scope || 'Not established — review the estimate'}.{' '}
        {candidate.confidence != null ? `AI confidence: ${pct(candidate.confidence * 100)}` : ''}
      </p>
      <div className="pi-grid">
        {(['estimated_cost', 'proposed_charge', 'incurred', 'billed', 'recovered'] as const).map(
          (k, i) => (
            <Field
              key={k}
              nullable={i < 2}
              label={
                [
                  'Estimated cost',
                  'Proposed client charge',
                  'Cost incurred (tracking only)',
                  'Amount billed',
                  'Amount recovered',
                ][i]
              }
              value={v[k]}
              onChange={(n) => setV({ ...v, [k]: n })}
            />
          ),
        )}
        <label className="pi-field">
          <span>Estimate trade</span>
          <select
            value={v.trade_category_id ?? ''}
            onChange={(e) =>
              setV({ ...v, trade_category_id: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">Unclassified</option>
            {TRADE_CATEGORIES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="pi-field">
          <span>Review state</span>
          <select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}>
            {[
              'potential',
              'reviewing',
              'priced',
              'sent',
              'approved',
              'rejected',
              'completed',
              'unrecovered',
              'recovered',
              'not_a_change',
            ].map((s) => (
              <option key={s} disabled={['approved', 'sent'].includes(s)} value={s}>
                {s.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
      </div>
      {v.estimated_cost !== null && v.proposed_charge !== null && (
        <p className="muted">
          Variation gross margin:{' '}
          {pct(
            v.proposed_charge > 0
              ? ((v.proposed_charge - v.estimated_cost) / v.proposed_charge) * 100
              : null,
          )}{' '}
          · markup:{' '}
          {pct(
            v.estimated_cost > 0
              ? ((v.proposed_charge - v.estimated_cost) / v.estimated_cost) * 100
              : null,
          )}
        </p>
      )}
      <p className="muted">
        Incurred, billed and recovered figures track this change; they do not add entries to project
        costs or revenue. Record actual invoices in Costs. Approval comes through the existing
        variation workflow.
      </p>
      <button disabled={busy || ['approved', 'sent'].includes(v.status)} onClick={() => onSave(v)}>
        Save review
      </button>
      {!candidate.variation_id && (
        <button
          className="primary"
          disabled={busy || candidate.proposed_charge === null}
          onClick={onVariation}
        >
          Create draft variation
        </button>
      )}
      {candidate.variation_id && (
        <Link className="pi-button" href="/variations">
          Open variation approval →
        </Link>
      )}
      <button disabled={busy} onClick={() => onSave({ ...v, status: 'not_a_change' })}>
        Not a change
      </button>
    </details>
  )
}
export default function JobIntelligence({ jobId }: { jobId: string }) {
  const [d, setD] = useState<Data | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState('Forecast & cash'),
    [price, setPrice] = useState(0),
    [target, setTarget] = useState<number | null>(null),
    [contingency, setContingency] = useState(0),
    [contract, setContract] = useState(0),
    [context, setContext] = useState({
      jobType: '',
      region: '',
      complexity: '',
      constructionType: '',
      size: null as number | null,
      labourIncluded: false,
      sourceTaxBasis: '',
      taxReconciled: false,
      assumptions: '',
      estimatedHours: {} as Record<string, number>,
    }),
    [confirm, setConfirm] = useState(false),
    [text, setText] = useState(''),
    [person, setPerson] = useState(''),
    [noteType, setNoteType] = useState('builder_note'),
    [filter, setFilter] = useState('all'),
    [tradeFilter, setTradeFilter] = useState('all'),
    [cards, setCards] = useState<{ section: string; text: string; evidence: string }[]>([]),
    [adjustments, setAdjustments] = useState<Record<number, number>>({})
  const url = `/api/jobs/${jobId}/intelligence`
  useEffect(() => {
    const select = () => { if (location.hash === '#review') setTab('Review'); else if (location.hash === '#scope') setTab('Correspondence & risks'); else if(location.hash === '#corrections') setTab('Corrections') }
    select(); window.addEventListener('hashchange', select)
    return () => window.removeEventListener('hashchange', select)
  }, [])
  const load = useCallback(async () => {
    try {
      const data: Data = await api(url)
      setD(data)
      setContract(data.originalContract)
      setPrice(data.currentSellPrice)
      setContext({ ...context, ...data.context, ...data.settings?.settings })
      setTarget(data.settings?.settings?.targetMargin ?? null)
      setContingency(data.settings?.settings?.contingency ?? 0)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [url]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void load()
  }, [load])
  async function action(body: unknown) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api(url, body)
      await load()
      setNotice('Saved. Your profitability review has been refreshed.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function analyse(file?: File) {
    setBusy(true)
    setError('')
    try {
      if (file) {
        const f = new FormData()
        f.set('file', file)
        const r = await fetch(`/api/jobs/${jobId}/correspondence`, { method: 'POST', body: f }),
          v = await r.json()
        if (!r.ok) throw new Error(v.error)
      } else await api(`/api/jobs/${jobId}/correspondence`, { text, person })
      setText('')
      await load()
      setNotice('Analysis saved to the ledger. Review any possible changes below.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function postmortem() {
    setBusy(true)
    setError('')
    try {
      const r = await api(`/api/jobs/${jobId}/profitability-analysis`, {})
      setCards(r.cards)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function learning(trade: number, decision: 'apply' | 'ignore') {
    setBusy(true)
    setError('')
    try {
      await api(`/api/jobs/${jobId}/learning`, {
        trade,
        decision,
        adjustmentPct:
          adjustments[trade] ?? d?.learning.find((l) => l.trade === trade)?.adjustmentPct,
      })
      await load()
      setNotice(
        decision === 'apply'
          ? 'A separate, builder-approved allowance was added to the draft estimate. Review it in the estimate.'
          : 'Recommendation ignored; your estimate is unchanged.',
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  let financial: ReturnType<typeof financialProfile> | null = null,
    gate: ReturnType<typeof marginGate> | null = null,
    gateError = ''
  try {
    if (d?.profile) financial = financialProfile(d.profile)
    if (
      d &&
      financial?.minimumMargin !== null &&
      financial?.minimumMargin !== undefined &&
      financial.viable
    )
      gate = marginGate(
        d.currentCost,
        price,
        financial.minimumMargin,
        target ?? financial.targetMargin!,
        contingency,
      )
  } catch (e) {
    gateError = (e as Error).message
  }
  const r = d?.review
  const saveSettings = (captureBaseline = false) =>
    action({
      action: 'settings',
      captureBaseline,
      originalContract: contract,
      settings: { ...context, targetMargin: target, contingency },
    })
  return (
    <main className="pi">
      <Link href={`/jobs/${jobId}`}>← Back to job</Link>
      <p className="muted mt-5">WORKA / PROFITABILITY INTELLIGENCE</p>
      <h1>{d?.job.address ?? 'Job profitability review'}</h1>
      <p className="muted">
        Know where the money went after you build it. All profitability amounts in AUD excluding
        GST.
      </p>
      {error && (
        <p role="alert" className="pi-alert pi-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="pi-alert">
          {notice}
        </p>
      )}
      {!d && !error && <p>Loading project evidence…</p>}
      {d && r && (
        <>
          <div className="pi-hero">
            <Metrics
              values={[
                [
                  r.complete ? 'Actual gross profit' : 'Gross profit to date',
                  money(r.actualProfit),
                ],
                [r.complete ? 'Actual margin' : 'Margin to date', pct(r.actualMargin)],
                ['Known margin at risk', money(d.risk.atRisk)],
                ['Unbilled change costs', money(d.risk.unbilled)],
              ]}
            />
            <p className="muted mt-4">
              {r.complete
                ? 'Completed review confirmed by builder.'
                : 'Provisional — actual costs and final revenue have not been confirmed complete.'}{' '}
              {d.risk.unknown} risks have unknown cost impact. Risk amounts are potential exposure,
              not certain losses.
            </p>
          </div>
          <nav className="pi-tabs" aria-label="Profitability views">
            {[
              'Review',
              'Corrections',
              'Forecast & cash',
              'Financial gate',
              'Correspondence & risks',
              'Actual costs',
              'Ledger',
              'Learning',
            ].map((t) => (
              <button key={t} aria-selected={tab === t} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </nav>
          {tab === 'Forecast & cash' && <JobControl jobId={jobId} />}
          {tab === 'Corrections' && <FinancialCorrections jobId={jobId} onSaved={()=>void load()}/>}
          {tab === 'Review' && (
            <>
              <Card title="Job profitability review">
                <Metrics
                  values={[
                    ['Original contract', money(r.originalContract)],
                    ['Approved variations', money(r.approvedVariations)],
                    ['Final / current revenue', money(r.revenue)],
                    ['Estimated cost', money(r.estimatedCost)],
                    ['Actual cost recorded', money(r.actualCost)],
                    ['Cost variance', `${money(r.variance)} · ${pct(r.variancePct)}`],
                    ['Expected gross profit', money(r.expectedProfit)],
                    ['Expected margin', pct(r.expectedMargin)],
                    [
                      'Margin movement',
                      r.marginMovement === null
                        ? 'Not available'
                        : `${r.marginMovement.toFixed(1)} points`,
                    ],
                  ]}
                />
                {r.missingPrices > 0 && (
                  <p className="pi-alert">
                    {r.missingPrices} estimate items have unknown prices. Totals are incomplete;
                    resolve these before confirming a review.
                  </p>
                )}
                {d.uncostedHours > 0 && (
                  <p className="pi-alert">{d.uncostedHours} site hours still need a cost rate.</p>
                )}
              </Card>
              <Card title="Where profit moved">
                <p className="muted">
                  Expected profit + approved variation revenue − trade overruns + trade savings =
                  actual profit. Change costs already in invoices are included once.
                </p>
                <div className="pi-waterfall">
                  {waterfallLayout(r.waterfall).map((w, i) => (
                    <div className="pi-waterfall-row" key={i}>
                      <span>
                        {w.label.startsWith('Trade ')
                          ? tradeName(Number(w.label.slice(6)))
                          : w.label}
                      </span>
                      <div className="pi-track">
                        <div
                          className="pi-bar"
                          style={{
                            left: `${w.left}%`,
                            width: `${w.width}%`,
                            background: w.endpoint
                              ? 'var(--orange-primary)'
                              : w.amount < 0
                                ? '#c87163'
                                : '#4a9b83',
                          }}
                        />
                      </div>
                      <span>{money(w.amount)}</span>
                    </div>
                  ))}
                </div>
              </Card>
              <Card title="Trade variance · largest overruns first">
                <div className="pi-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Trade</th>
                        <th>Estimate</th>
                        <th>Actual</th>
                        <th>Variance</th>
                        <th>Variance %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.trades.map((t) => (
                        <tr key={t.id ?? 'unclassified'}>
                          <td>
                            <a href={`#trade-${t.id}`}>{tradeName(t.id)}</a>
                          </td>
                          <td>{money(t.estimated)}</td>
                          <td>{money(t.actual)}</td>
                          <td className={t.variance > 0 ? 'pi-bad' : 'pi-good'}>
                            {money(t.variance)}
                          </td>
                          <td>{pct(t.variancePct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {r.trades.map((t) => (
                  <details id={`trade-${t.id}`} key={t.id ?? 'u'}>
                    <summary>{tradeName(t.id)} · invoices, labour and project history</summary>
                    <p className="muted">
                      Labour hours: estimated {t.estimatedHours ?? 'unknown'}, recorded {t.hours},
                      variance {t.hoursVariance ?? 'unknown'}. Estimated labour cost:{' '}
                      {money(t.estimatedLabourCost)}; actual labour cost identified:{' '}
                      {money(t.actualLabourCost)}. No hours are inferred from costs.
                    </p>
                    {t.invoices.map((i) => (
                      <p key={i.id} className="text-sm my-2">
                        {i.description} · {i.supplier} {i.invoice_ref} · {money(i.amount)}
                      </p>
                    ))}
                    {d.ledger
                      .filter((e) => e.metadata?.trade_category_id === t.id)
                      .map((e) => (
                        <p className="text-sm my-2" key={e.id}>
                          {e.event_type.replaceAll('_', ' ')}: {e.description}
                        </p>
                      ))}
                    {!t.invoices.length && (
                      <p className="muted">No invoice evidence recorded for this trade.</p>
                    )}
                  </details>
                ))}
              </Card>
              <Card title="Complete the job review">
                <p className="muted">
                  Capture your original baseline in Financial gate first. A confirmed review
                  closes this job and supplies comparable-job learning. New costs or changed assumptions require
                  confirmation again.
                </p>
                <label className="pi-check">
                  <input
                    type="checkbox"
                    checked={confirm}
                    onChange={(e) => setConfirm(e.target.checked)}
                  />
                  I confirm all invoices, credits, labour, remaining commitments and approved
                  variation revenue are reconciled on an ex-GST basis. These are the final job
                  costs. I have reviewed the trade mappings, including costs deliberately left Unclassified.
                </label>
                <button
                  disabled={busy || !confirm || (r.complete && d.job.status==='complete')}
                  className="primary"
                  onClick={() => action({ action: 'complete', confirmed: true, mappingsConfirmed: true })}
                >
                  {r.complete && d.job.status==='complete' ? 'Job completed · review confirmed' : 'Complete job and confirm review'}
                </button>
              </Card>
              <Card title="Profitability analyst">
                <p className="muted">
                  AI selects and organises findings from verified financial evidence. It cannot
                  change the numbers or invent a cause.
                </p>
                <button disabled={busy || !r.complete} onClick={postmortem}>
                  {busy ? 'Working…' : 'Generate evidence-backed post-mortem'}
                </button>
                {(cards.length
                  ? cards
                  : (d.ledger.find(
                      (e) =>
                        e.event_type === 'profitability_analysis' &&
                        e.metadata?.fingerprint === d.evidenceKey,
                    )?.metadata?.cards ?? [])
                ).map((c: { section: string; text: string; evidence: string }, i: number) => (
                  <div className="mt-5" key={i}>
                    <h3>{c.section}</h3>
                    <p>{c.text}</p>
                    <small>Evidence: {c.evidence || 'Insufficient evidence'}</small>
                  </div>
                ))}
              </Card>
            </>
          )}
          {tab === 'Financial gate' && (
            <>
              <Card title="Financial viability check">
                <p className="muted">
                  AI drafts. You approve. Price and contingency below are a live scenario; saved
                  quote prices change only through estimate review.
                </p>
                {!financial?.viable && (
                  <p className="pi-alert">
                    <Link href="/business">Set your business financial profile</Link> to establish
                    minimum and target margin.
                  </p>
                )}
                <div className="pi-grid">
                  <Field
                    label="Scenario sell price"
                    value={price}
                    onChange={(n) => setPrice(n ?? 0)}
                  />
                  <Field
                    nullable
                    label="Target gross margin % (blank uses business target)"
                    value={target}
                    onChange={setTarget}
                  />
                  <Field
                    label="Cost contingency %"
                    value={contingency}
                    onChange={(n) => setContingency(n ?? 0)}
                  />
                </div>
                {gateError && <p role="alert">{gateError}</p>}
                {gate && (
                  <>
                    <span
                      className={`pi-badge ${gate.status === 'HEALTHY' ? 'pi-good' : 'pi-bad'}`}
                    >
                      {d.currentMissingPrices ? 'INCOMPLETE ESTIMATE' : gate.status}
                    </span>
                    <Metrics
                      values={[
                        ['Estimated cost + contingency', money(gate.cost)],
                        ['Gross profit', money(gate.profit)],
                        ['Markup', pct(gate.markup)],
                        ['Gross margin', pct(gate.margin)],
                        ['Minimum margin', pct(financial?.minimumMargin)],
                        ['Target margin', pct(target ?? financial?.targetMargin)],
                        [
                          'Margin buffer',
                          gate.buffer === null ? 'Unknown' : `${gate.buffer.toFixed(1)} points`,
                        ],
                        ['Allocated overhead', money(gate.overhead)],
                        ['Contribution before overhead', money(gate.contribution)],
                        ['Profit after overhead', money(gate.netProfit)],
                        ['Minimum sustainable price', money(gate.minimumPrice)],
                        ['Target sell price', money(gate.recommendedPrice)],
                      ]}
                    />
                    <p className="pi-alert">
                      Your {pct(gate.markup)} markup produces a {pct(gate.margin)} gross margin. At
                      your overhead and profit target, this scenario is {money(gate.shortfall)}{' '}
                      below target return.
                    </p>
                    <p className="muted">
                      Overhead is allocated as a share of sell price using your business revenue
                      plan. This does not forecast project cash timing.
                    </p>
                    <button onClick={() => setPrice(gate.recommendedPrice)}>
                      Try target price
                    </button>
                  </>
                )}
                <Link href={`/jobs/${jobId}`} className="pi-button">
                  Open estimate to review pricing →
                </Link>
              </Card>
              <Card title="Original estimate and project assumptions">
                <label className="pi-field">
                  Project source amounts
                  <select value={context.sourceTaxBasis} onChange={(e) => setContext({ ...context, sourceTaxBasis: e.target.value, taxReconciled: false })}>
                    <option value="">Unknown — reconciliation required</option>
                    <option value="exclusive">AUD excluding GST</option>
                    <option value="inclusive">AUD including GST</option>
                  </select>
                </label>
                <p className="muted">Legacy GST treatment is not assumed. For mixed or unclear records, reconcile each source first. This declaration does not convert existing values.</p>
                <label>
                  <input type="checkbox" checked={context.taxReconciled} onChange={(e) => setContext({ ...context, taxReconciled: e.target.checked })} />{' '}
                  I have checked the source GST treatment and reconciled the estimate, contract, approved variations and actual costs to AUD excluding GST.
                </label>
                <p className="muted">
                  Capture the estimate before variations so future changes cannot overwrite your
                  comparison. Confirm the original contract excluding GST; legacy variation tax
                  labels may need review.
                </p>
                <div className="pi-grid">
                  <Field
                    label="Original contract, excluding GST"
                    value={contract}
                    onChange={(n) => setContract(n ?? 0)}
                  />
                  <TextField
                    label="Project type (renovation, extension, new build…)"
                    value={context.jobType}
                    onChange={(s) => setContext({ ...context, jobType: s })}
                  />
                  <TextField
                    label="Region / postcode"
                    value={context.region}
                    onChange={(s) => setContext({ ...context, region: s })}
                  />
                  <TextField
                    label="Complexity / finish level"
                    value={context.complexity}
                    onChange={(s) => setContext({ ...context, complexity: s })}
                  />
                  <TextField
                    label="Construction type"
                    value={context.constructionType}
                    onChange={(s) => setContext({ ...context, constructionType: s })}
                  />
                  <Field
                    nullable
                    label="Project size m²"
                    value={context.size}
                    onChange={(s) => setContext({ ...context, size: s })}
                  />
                </div>
                <details>
                  <summary>Estimated labour hours by trade (optional)</summary>
                  <div className="pi-grid">
                    {r.trades
                      .filter((t) => t.id !== null)
                      .map((t) => (
                        <Field
                          key={t.id}
                          nullable
                          label={tradeName(t.id)}
                          value={context.estimatedHours[String(t.id)] ?? null}
                          onChange={(n) => {
                            const hours = { ...context.estimatedHours }
                            if (n === null) delete hours[String(t.id)]
                            else hours[String(t.id)] = n
                            setContext({ ...context, estimatedHours: hours })
                          }}
                        />
                      ))}
                  </div>
                  <p className="muted">
                    Enter hours from the original estimate; no hours are inferred from money.
                  </p>
                </details>
                <label className="pi-check">
                  <input
                    type="checkbox"
                    checked={context.labourIncluded}
                    onChange={(e) => setContext({ ...context, labourIncluded: e.target.checked })}
                  />
                  Site labour costs are already included in the cost ledger; do not add the separate
                  site-hours ledger again.
                </label>
                <label className="pi-field">
                  <span>Assumptions and exclusions</span>
                  <textarea
                    value={context.assumptions}
                    onChange={(e) => setContext({ ...context, assumptions: e.target.value })}
                  />
                </label>
                <button
                  className="primary"
                  disabled={busy || !d.quote}
                  onClick={() => saveSettings(!d.settings?.baseline_items?.length)}
                >
                  {d.settings?.baseline_items?.length
                    ? 'Save assumptions'
                    : 'Capture original baseline and save'}
                </button>
              </Card>
            </>
          )}
          {tab === 'Correspondence & risks' && (
            <>
              <Card title="Project correspondence intelligence">
                <p className="muted">
                  Paste a client message, email or architect instruction. WorkA will identify
                  possible scope changes for your review. No approved variation is created
                  automatically.
                </p>
                <TextField label="Person / company" value={person} onChange={setPerson} />
                <label className="pi-field">
                  <span>Correspondence</span>
                  <textarea
                    placeholder="Can we change the western windows to black aluminium and make them 2400 high?"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </label>
                <button
                  className="primary"
                  disabled={busy || !text.trim()}
                  onClick={() => analyse()}
                >
                  {busy ? 'Analysing…' : 'Analyse correspondence'}
                </button>
                <button
                  disabled={busy || !text.trim()}
                  onClick={() => action({ action: 'risk', description: text })}
                >
                  Record risk for manual review
                </button>
                <label className="pi-field">
                  <span>Or upload PDF / TXT / EML</span>
                  <input
                    type="file"
                    accept=".pdf,.txt,.eml"
                    disabled={busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) void analyse(f)
                    }}
                  />
                </label>
              </Card>
              <Card title="Margin at risk">
                <Metrics
                  values={[
                    ['Known cost exposure', money(d.risk.atRisk)],
                    ['Unapproved candidates', String(d.risk.unapproved)],
                    ['Unknown-cost risks', String(d.risk.unknown)],
                    ['Unrecovered change costs', money(d.risk.unrecovered)],
                    ['Variation recovery rate', pct(d.risk.recoveryRate)],
                  ]}
                />
                {d.candidates.length === 0 && (
                  <p className="muted mt-4">
                    No commercial risks recorded yet. Analyse correspondence or record a note in the
                    ledger.
                  </p>
                )}
                {d.untrackedVariations.map((v) => (
                  <div key={v.id} className="pi-alert">
                    <p>
                      {v.title} · existing {v.status} variation · {money(v.amount)}
                    </p>
                    <button
                      disabled={busy}
                      onClick={() => action({ action: 'track_variation', id: v.id })}
                    >
                      Track costs and recovery
                    </button>
                  </div>
                ))}
                {d.candidates.map((c) => (
                  <CandidateEditor
                    key={c.id}
                    candidate={c}
                    busy={busy}
                    onSave={(v) => action({ action: 'candidate', id: c.id, values: v })}
                    onVariation={() => action({ action: 'variation', id: c.id })}
                  />
                ))}
              </Card>
            </>
          )}
          {tab === 'Actual costs' && (
            <>
              <Card title="Import actual job costs">
                <CostImport
                  jobId={jobId}
                  address={d.job.address}
                  onSaved={() => {
                    void load()
                    setNotice(
                      'Actual costs imported. Review the trade variances and confirm completion when all costs are in.',
                    )
                  }}
                />
              </Card>
              <Card title="Recorded costs">
                <p className="muted">
                  Correct categories here; original import values and corrections are retained.
                  Imported labour is included in the amount according to the approved mapping.
                </p>
                {d.costs.map((c) => (
                  <details key={c.id}>
                    <summary>
                      {c.description} · {money(c.amount)} · {tradeName(c.trade_category_id)}
                    </summary>
                    <p className="muted">
                      {c.supplier} · Invoice {c.invoice_ref || 'not supplied'} · {c.incurred_on} ·{' '}
                      {c.source_ref || 'Manual cost'}
                    </p>
                    <label className="pi-field">
                      <span>Correct estimate trade</span>
                      <select
                        value={c.trade_category_id ?? ''}
                        disabled={busy}
                        onChange={(e) =>
                          action({
                            action: 'classify',
                            id: c.id,
                            trade: e.target.value ? Number(e.target.value) : null,
                            category: c.category ?? 'miscellaneous',
                          })
                        }
                      >
                        <option value="">Unclassified</option>
                        {TRADE_CATEGORIES.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </details>
                ))}
                {!d.costs.length && <p>No actual cost entries yet.</p>}
              </Card>
            </>
          )}
          {tab === 'Ledger' && (
            <>
              <Card title="Add to the project memory">
                <label className="pi-field">
                  <span>Event type</span>
                  <select value={noteType} onChange={(e) => setNoteType(e.target.value)}>
                    {[
                      'builder_note',
                      'RFI',
                      'client_decision',
                      'architect_instruction',
                      'cost_event',
                      'approval',
                    ].map((s) => (
                      <option value={s} key={s}>
                        {s.replaceAll('_', ' ')}
                      </option>
                    ))}
                  </select>
                </label>
                <TextField label="Person / company" value={person} onChange={setPerson} />
                <label className="pi-field">
                  <span>Description and evidence reference</span>
                  <textarea value={text} onChange={(e) => setText(e.target.value)} />
                </label>
                <button
                  disabled={busy || !text.trim()}
                  onClick={() =>
                    action({ action: 'note', type: noteType, description: text, person })
                  }
                >
                  Save builder note
                </button>
              </Card>
              <Card title="Project intelligence ledger">
                <div className="pi-grid">
                  <label className="pi-field">
                    <span>Event filter</span>
                    <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                      <option value="all">All events</option>
                      {Array.from(new Set(d.ledger.map((e) => e.event_type))).map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                  <label className="pi-field">
                    <span>Trade filter</span>
                    <select value={tradeFilter} onChange={(e) => setTradeFilter(e.target.value)}>
                      <option value="all">All trades</option>
                      {TRADE_CATEGORIES.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {d.ledger
                  .filter(
                    (e) =>
                      (filter === 'all' || e.event_type === filter) &&
                      (tradeFilter === 'all' ||
                        e.metadata?.trade_category_id === Number(tradeFilter)),
                  )
                  .map((e) => (
                    <article className="pi-ledger" key={`${e.event_type}-${e.id}`}>
                      <small>
                        {new Date(e.created_at).toLocaleString('en-AU')} ·{' '}
                        {e.event_type.replaceAll('_', ' ')}
                      </small>
                      <p>{e.description}</p>
                      {e.metadata?.analysis && (
                        <p className="muted">
                          Sender: {e.metadata.analysis.sender || 'Not recorded'} · Date:{' '}
                          {e.metadata.analysis.correspondence_date || 'Not recorded'}<br />
                          Trade: {e.metadata.analysis.trade_label || 'Needs review'} · Cost impact:
                          Unknown · Approval at capture: Not recorded<br />
                          {e.metadata.analysis.action_required}
                        </p>
                      )}
                      {e.metadata?.evidence && (
                        <p className="muted">Evidence: {String(e.metadata.evidence)}</p>
                      )}
                      {typeof e.metadata?.confidence === 'number' && (
                        <small>
                          AI confidence {pct(e.metadata.confidence * 100)} ·{' '}
                          {e.metadata.builder_confirmed
                            ? 'Builder confirmed'
                            : 'Awaiting builder review'}
                        </small>
                      )}
                    </article>
                  ))}
              </Card>
            </>
          )}
          {tab === 'Learning' && (
            <Card title="WorkA learns from every job">
              <p className="muted">
                Recommendations compare the same project type, region, construction type and
                complexity, within 30% of project size. They use weighted cost variance from
                builder-confirmed reviews.
              </p>
              {!d.learning.length && (
                <p className="pi-alert">
                  Insufficient comparable completed-job evidence. Fill in project assumptions and
                  confirm completed reviews to build your learning history. No adjustment has been
                  inferred.
                </p>
              )}
              {d.learning.map((l) => (
                <div className="pi-card" key={l.trade}>
                  <h3>{tradeName(l.trade)}</h3>
                  <p>
                    Your costs averaged {l.adjustmentPct}%{' '}
                    {l.adjustmentPct >= 0 ? 'above' : 'below'} estimate across {l.count} comparable
                    jobs. {l.confidence} confidence.
                  </p>
                  <Field
                    label="Proposed allowance adjustment %"
                    value={adjustments[l.trade] ?? l.adjustmentPct}
                    onChange={(n) => setAdjustments({ ...adjustments, [l.trade]: n ?? 0 })}
                  />
                  <p className="muted">
                    Applying adds a separate allowance to the current draft estimate. Review scope
                    differences before applying. Savings require manual estimate review.
                  </p>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !d.quote ||
                      !['draft', 'pending_review'].includes(d.quote.status) ||
                      (adjustments[l.trade] ?? l.adjustmentPct) <= 0
                    }
                    onClick={() => learning(l.trade, 'apply')}
                  >
                    Apply adjustment
                  </button>
                  <button disabled={busy} onClick={() => learning(l.trade, 'ignore')}>
                    Ignore
                  </button>
                  <details>
                    <summary>Comparable job evidence</summary>
                    {l.jobs.map((id) => (
                      <p key={id}>
                        <Link href={`/jobs/${id}/profitability`}>Open completed job →</Link>
                      </p>
                    ))}
                  </details>
                </div>
              ))}
            </Card>
          )}
        </>
      )}
    </main>
  )
}
