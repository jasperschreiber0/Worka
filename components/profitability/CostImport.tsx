'use client'
import { useState } from 'react'
import {
  IMPORT_FIELDS,
  COST_CATEGORIES,
  suggestMapping,
  mapCostRows,
  type ColumnMapping,
  type ImportOptions,
} from '@/lib/cost-import'
import { TRADE_CATEGORIES } from '@/lib/trade-taxonomy'
import { api, money } from './ui'
export default function CostImport({
  jobId,
  address,
  onSaved,
}: {
  jobId: string
  address: string
  onSaved: () => void
}) {
  const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[]>([]),
    [sheet, setSheet] = useState(0),
    [header, setHeader] = useState(0),
    [name, setName] = useState(''),
    [mapping, setMapping] = useState<ColumnMapping>(suggestMapping([])),
    [options, setOptions] = useState<ImportOptions>({
      taxBasis: '',
      labourBasis: 'included',
      defaultDate: new Date().toLocaleDateString('en-CA'),
      projectLabel: address,
    }),
    [approved, setApproved] = useState(false),
    [labour, setLabour] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [classifications, setClassifications] = useState<
      Record<number, { trade: number | null; category: string }>
    >({})
  const rows = sheets[sheet]?.rows.slice(header + 1) ?? [],
    headers = sheets[sheet]?.rows[header] ?? []
  let preview: ReturnType<typeof mapCostRows> = [],
    validation = ''
  try {
    if (rows.length) preview = mapCostRows(rows, mapping, options)
  } catch (e) {
    validation = (e as Error).message
  }
  const rejected = preview.filter((r) => r.error).length
  async function upload(file: File) {
    setBusy(true)
    setError('')
    setSheets([])
    try {
      const f = new FormData()
      f.set('file', file)
      const r = await fetch(`/api/jobs/${jobId}/cost-import`, { method: 'POST', body: f }),
        d = await r.json()
      if (!r.ok) throw new Error(d.error)
      setSheets(d.sheets)
      setName(d.name)
      setSheet(0)
      setHeader(0)
      setMapping(suggestMapping(d.sheets[0]?.rows[0] ?? []))
      setClassifications({})
      setApproved(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function save() {
    setBusy(true)
    setError('')
    try {
      await api(
        `/api/jobs/${jobId}/cost-import`,
        {
          rows,
          mapping,
          options,
          name,
          confirmed: approved,
          labourReconciled: labour,
          classifications,
        },
        'PUT',
      )
      setSheets([])
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <p className="muted">
        CSV / XLSX · up to 2 MB and 2,000 cost rows. Dates use Australian day/month order. Negative
        credits and formula cells need review before import.
      </p>
      <label className="pi-field">
        <span>Upload actual costs</span>
        <input
          type="file"
          accept=".csv,.tsv,.xlsx"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void upload(f)
          }}
        />
      </label>
      {error && (
        <p role="alert" className="pi-alert pi-error">
          {error}
        </p>
      )}
      {!!sheets.length && (
        <>
          <div className="pi-grid">
            <label className="pi-field">
              <span>Worksheet</span>
              <select
                value={sheet}
                onChange={(e) => {
                  const i = Number(e.target.value)
                  setSheet(i)
                  setHeader(0)
                  setMapping(suggestMapping(sheets[i].rows[0]))
                  setClassifications({})
                  setApproved(false)
                }}
              >
                {sheets.map((s, i) => (
                  <option key={i} value={i}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="pi-field">
              <span>Header row</span>
              <input
                type="number"
                min={1}
                max={sheets[sheet].rows.length}
                value={header + 1}
                onChange={(e) => {
                  const i = Math.max(0, Number(e.target.value) - 1)
                  setHeader(i)
                  setMapping(suggestMapping(sheets[sheet].rows[i] ?? []))
                  setClassifications({})
                  setApproved(false)
                }}
              />
            </label>
          </div>
          <h3>Confirm column mapping</h3>
          <div className="pi-grid">
            {IMPORT_FIELDS.map((f) => (
              <label key={f} className="pi-field">
                <span>
                  {f}
                  {['description', 'amount'].includes(f) ? ' *' : ''}
                </span>
                <select
                  value={mapping[f]}
                  onChange={(e) => {
                    setMapping({ ...mapping, [f]: Number(e.target.value) })
                    setApproved(false)
                    setClassifications({})
                  }}
                >
                  <option value={-1}>Not mapped</option>
                  {headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="pi-grid">
            <label className="pi-field">
              <span>Amounts in this file</span>
              <select
                value={options.taxBasis}
                onChange={(e) => {
                  setOptions({ ...options, taxBasis: e.target.value as ImportOptions['taxBasis'] })
                  setApproved(false)
                }}
              >
                <option value="">Choose the source GST basis</option>
                <option value="exclusive">Exclude GST — keep amounts</option>
                <option value="inclusive">Include 10% GST — divide by 1.1</option>
              </select>
            </label>
            <label className="pi-field">
              <span>Labour cost column</span>
              <select
                value={options.labourBasis}
                onChange={(e) => {
                  setOptions({
                    ...options,
                    labourBasis: e.target.value as ImportOptions['labourBasis'],
                  })
                  setApproved(false)
                }}
              >
                <option value="included">Already included in Amount</option>
                <option value="additional">Additional to Amount — add it</option>
              </select>
            </label>
            <label className="pi-field">
              <span>Date when file has no date</span>
              <input
                type="date"
                value={options.defaultDate}
                onChange={(e) => setOptions({ ...options, defaultDate: e.target.value })}
              />
            </label>
            <label className="pi-field">
              <span>Expected project label in spreadsheet</span>
              <input
                value={options.projectLabel}
                onChange={(e) => setOptions({ ...options, projectLabel: e.target.value })}
              />
            </label>
          </div>
          <p className="pi-alert">
            {preview.length} rows · {rejected} need correction · Total to import:{' '}
            {money(preview.reduce((s, r) => s + (r.entry?.amount ?? 0), 0))}.{' '}
            {options.taxBasis === 'inclusive'
              ? 'Only use conversion if every amount includes 10% GST; split mixed-tax files first.'
              : 'No GST conversion will be made.'}{' '}
            Missing categories remain unclassified against the estimate until you choose a trade.
          </p>
          {validation && <p role="alert">{validation}</p>}
          <div className="pi-scroll">
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Description / error</th>
                  <th>Amount ex GST</th>
                  <th>Cost category</th>
                  <th>Estimate trade</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r, i) => (
                  <tr key={i}>
                    <td>{r.row}</td>
                    <td>
                      {r.error ? <span className="pi-bad">{r.error}</span> : r.entry?.description}
                    </td>
                    <td>{money(r.entry?.amount)}</td>
                    <td>
                      {r.entry && (
                        <select
                          aria-label={`Row ${r.row} cost category`}
                          value={classifications[i]?.category ?? r.entry.category}
                          onChange={(e) => {
                            setClassifications({
                              ...classifications,
                              [i]: {
                                trade: classifications[i]?.trade ?? r.entry!.trade_category_id,
                                category: e.target.value,
                              },
                            })
                            setApproved(false)
                          }}
                        >
                          {COST_CATEGORIES.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      {r.entry && (
                        <select
                          aria-label={`Row ${r.row} estimate trade`}
                          value={
                            (classifications[i]
                              ? classifications[i].trade
                              : r.entry.trade_category_id) ?? ''
                          }
                          onChange={(e) => {
                            setClassifications({
                              ...classifications,
                              [i]: {
                                trade: e.target.value === '' ? null : Number(e.target.value),
                                category: classifications[i]?.category ?? r.entry!.category,
                              },
                            })
                            setApproved(false)
                          }}
                        >
                          <option value="">Unclassified</option>
                          {TRADE_CATEGORIES.map((t) => (
                            <option value={t.id} key={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!!rejected && (
            <p className="muted">
              Correct rejected rows in your spreadsheet and upload it again. No partial import will
              be saved.
            </p>
          )}
          <label className="pi-check">
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
            />
            I approve this mapping, classification, converted amounts and dates.
          </label>
          <label className="pi-check">
            <input type="checkbox" checked={labour} onChange={(e) => setLabour(e.target.checked)} />
            I checked for existing invoices and site labour costs so this import will not duplicate
            costs already recorded.
          </label>
          <button
            className="primary"
            disabled={busy || !approved || !labour || !!rejected || !!validation || !preview.length}
            onClick={save}
          >
            {busy ? 'Saving…' : 'Approve and import actual costs'}
          </button>
        </>
      )}
    </div>
  )
}
