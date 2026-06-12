'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Link from 'next/link'

const DEMO_BUILDER_ID = '00000000-0000-0000-0000-000000000001'

// ─── Trade category matching ──────────────────────────────────────────────────

const TRADE_CATEGORIES = [
  { id: 1,  name: 'Earthworks & Site Prep',       keywords: ['earthwork', 'site prep', 'excavat', 'cut and fill', 'earthworks', 'site work', 'sitework'] },
  { id: 2,  name: 'Concrete',                     keywords: ['concrete', 'slab', 'footing', 'foundation', 'pour', 'formwork', 'reinforce'] },
  { id: 3,  name: 'Framing & Structural',         keywords: ['framing', 'frame', 'structural', 'timber frame', 'stud', 'wall frame', 'roof frame', 'steel frame', 'truss'] },
  { id: 4,  name: 'Roofing',                      keywords: ['roof', 'colorbond', 'metal roof', 'gutter', 'fascia', 'downpipe', 'sarking', 'ridge', 'hip'] },
  { id: 5,  name: 'Windows & External Doors',     keywords: ['window', 'external door', 'sliding door', 'glazing', 'alum', 'french door', 'bi-fold'] },
  { id: 6,  name: 'External Cladding',            keywords: ['clad', 'weatherboard', 'render', 'brick', 'external wall', 'facade', 'hardie', 'linea'] },
  { id: 7,  name: 'Insulation',                   keywords: ['insulat', 'batts', 'r-value', 'thermal', 'glasswool', 'rockwool', 'batt'] },
  { id: 8,  name: 'Internal Linings',             keywords: ['lining', 'plasterboard', 'gyprock', 'cornice', 'internal wall', 'drywall', 'plaster'] },
  { id: 9,  name: 'Joinery & Cabinetry',          keywords: ['joinery', 'cabinet', 'kitchen', 'wardrobe', 'vanity', 'shelf', 'built-in', 'drawer'] },
  { id: 10, name: 'Painting',                     keywords: ['paint', 'coat', 'primer', 'brush', 'roller', 'decor', 'finish coat', 'undercoat'] },
  { id: 11, name: 'Plumbing',                     keywords: ['plumb', 'pipe', 'drain', 'hot water', 'gas', 'tap', 'basin', 'toilet', 'shower', 'bath'] },
  { id: 12, name: 'Electrical',                   keywords: ['electr', 'power', 'light', 'cable', 'switch', 'board', 'circuit', 'gpo', 'outlet', 'wiring'] },
  { id: 13, name: 'Tiling & Finishes',            keywords: ['tile', 'tiling', 'floor finish', 'bathroom finish', 'grout', 'porcelain', 'timber floor', 'carpet', 'vinyl'] },
]

function matchCategory(raw: string): { id: number; name: string } | null {
  const lower = raw.toLowerCase().trim()
  // Exact name match first
  const exact = TRADE_CATEGORIES.find((c) => c.name.toLowerCase() === lower)
  if (exact) return { id: exact.id, name: exact.name }
  // Keyword match
  for (const cat of TRADE_CATEGORIES) {
    if (cat.keywords.some((kw) => lower.includes(kw))) {
      return { id: cat.id, name: cat.name }
    }
  }
  return null
}

// ─── CSV parsing ──────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}

const HEADER_ALIASES: Record<string, string> = {
  trade_category: 'category', 'trade category': 'category', category: 'category', cat: 'category',
  description: 'description', desc: 'description', item: 'description', 'line item': 'description', name: 'description',
  unit: 'unit', uom: 'unit', measure: 'unit', units: 'unit',
  rate: 'rate', rate_ex_gst: 'rate', 'rate ex gst': 'rate', price: 'rate', cost: 'rate', 'unit rate': 'rate', 'unit cost': 'rate',
  supplier: 'supplier', supplier_name: 'supplier', 'supplier name': 'supplier',
}

interface ParsedRow {
  raw_category: string
  matched_category: { id: number; name: string } | null
  description: string
  unit: string
  rate: number | null
  valid: boolean
  error?: string
}

function parseCSV(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return []

  const headers = parseCSVLine(lines[0]).map((h) => HEADER_ALIASES[h.toLowerCase().trim()] ?? null)
  const colIdx = {
    category: headers.indexOf('category'),
    description: headers.indexOf('description'),
    unit: headers.indexOf('unit'),
    rate: headers.indexOf('rate'),
  }

  if (colIdx.category === -1 || colIdx.description === -1 || colIdx.rate === -1) return []

  return lines.slice(1).map((line) => {
    const cells = parseCSVLine(line)
    const raw_category = cells[colIdx.category] ?? ''
    const description = cells[colIdx.description] ?? ''
    const unit = colIdx.unit >= 0 ? (cells[colIdx.unit] ?? 'ea') : 'ea'
    const rateRaw = cells[colIdx.rate] ?? ''
    const rate = parseFloat(rateRaw.replace(/[$,\s]/g, ''))

    if (!raw_category || !description) {
      return { raw_category, matched_category: null, description, unit, rate: null, valid: false, error: 'Missing category or description' }
    }
    if (isNaN(rate) || rate <= 0) {
      return { raw_category, matched_category: null, description, unit, rate: null, valid: false, error: 'Invalid rate' }
    }

    const matched_category = matchCategory(raw_category)
    return {
      raw_category,
      matched_category,
      description,
      unit,
      rate,
      valid: matched_category !== null,
      error: matched_category ? undefined : 'Unknown trade category',
    }
  }).filter((r) => r.description || r.raw_category)
}

// ─── Example CSV ──────────────────────────────────────────────────────────────

const EXAMPLE_CSV = `trade_category,description,unit,rate_ex_gst
Earthworks,Bulk excavation – bobcat,m³,45
Concrete,65MPa slab pour – 100mm,m²,110
Concrete,Standard strip footing,lm,85
Framing,Pine wall frame – 90mm studs,lm,42
Framing,Roof truss – standard pitch,ea,420
Roofing,Colorbond roofing sheet,m²,55
Roofing,Gutters and downpipes,lm,38
Windows,Aluminium double-hung window,ea,680
Plumbing,Hot water unit – 26L gas,ea,1200
Plumbing,Cold water rough-in,ea,320
Electrical,GPO double power point,ea,85
Electrical,LED downlight installed,ea,120
Painting,Walls and ceiling – 2 coats,m²,18
Tiling,Floor tile – 300x300,m²,65
Joinery,Kitchen cabinet – per lineal metre,lm,950
`

function downloadExampleCSV() {
  const blob = new Blob([EXAMPLE_CSV], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'worka-rates-template.csv'
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Component ────────────────────────────────────────────────────────────────

type Stage = 'idle' | 'extracting' | 'preview' | 'importing' | 'done'

interface ExistingRate {
  id: string
  supplier_name: string
  line_item_key: string
  rate: number
  unit: string
  imported_at: string
}

export default function RatesPage() {
  const [builderId, setBuilderId] = useState(DEMO_BUILDER_ID)
  const [stage, setStage] = useState<Stage>('idle')
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [supplierName, setSupplierName] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [importedCount, setImportedCount] = useState(0)
  const [existingRates, setExistingRates] = useState<ExistingRate[]>([])
  const [loadingExisting, setLoadingExisting] = useState(true)
  const [importError, setImportError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Resolve builder ID from session
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return
    import('@supabase/auth-helpers-nextjs').then(({ createClientComponentClient }) => {
      createClientComponentClient().auth.getSession().then(({ data }) => {
        if (data.session?.user.id) setBuilderId(data.session.user.id)
      })
    })
  }, [])

  // Load existing rates
  useEffect(() => {
    fetch(`/api/rates?builder_id=${builderId}`)
      .then((r) => r.json())
      .then((d: { rates: ExistingRate[] }) => setExistingRates(d.rates ?? []))
      .catch(() => {})
      .finally(() => setLoadingExisting(false))
  }, [builderId, importedCount])

  function handleFile(file: File) {
    const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf'
    const isCsv = file.name.toLowerCase().endsWith('.csv') || file.type === 'text/csv'

    if (!isPdf && !isCsv) {
      alert('Please upload a CSV or PDF file.')
      return
    }

    if (isPdf) {
      setStage('extracting')
      const form = new FormData()
      form.append('file', file)
      fetch('/api/rates/extract-pdf', { method: 'POST', body: form })
        .then((r) => r.json())
        .then((data: { rates?: Array<{ trade_category_id: number; trade_category_name: string; description: string; unit: string; rate: number }>; error?: string; demo?: boolean }) => {
          if (data.error || !data.rates?.length) {
            setStage('idle')
            setImportError(data.error ?? 'No rates found in this PDF.')
            return
          }
          // Convert to ParsedRow format — already matched by Claude
          const parsed: ParsedRow[] = data.rates.map((r) => ({
            raw_category: r.trade_category_name,
            matched_category: { id: r.trade_category_id, name: r.trade_category_name },
            description: r.description,
            unit: r.unit,
            rate: r.rate,
            valid: true,
          }))
          setRows(parsed)
          setStage('preview')
          if (data.demo) setImportError('Demo mode — example rates shown. Connect your Anthropic API key to extract from real PDFs.')
        })
        .catch(() => {
          setStage('idle')
          setImportError('Upload failed — please try again.')
        })
      return
    }

    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      const parsed = parseCSV(text)
      if (!parsed.length) {
        setImportError('Could not read this CSV — no matching rows found. Download the template to see the expected format.')
        return
      }
      setRows(parsed)
      setStage('preview')
      setTimeout(() => document.getElementById('import-actions')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100)
    }
    reader.readAsText(file)
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }, [])

  async function handleImport() {
    const validRows = rows.filter((r) => r.valid && r.matched_category && r.rate !== null)
    if (!validRows.length) return

    setStage('importing')
    setImportError(null)

    try {
      const res = await fetch('/api/rates/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builder_id: builderId,
          supplier_name: supplierName.trim() || 'My rates',
          rates: validRows.map((r) => ({
            trade_category_id: r.matched_category!.id,
            trade_category_name: r.matched_category!.name,
            description: r.description,
            unit: r.unit,
            rate: r.rate!,
          })),
        }),
      })

      const data = (await res.json()) as { imported?: number; error?: string }
      if (!res.ok || !data.imported) {
        setImportError(data.error ?? 'Import failed — please try again.')
        setStage('preview')
        return
      }

      setImportedCount((c) => c + data.imported!)
      setStage('done')
    } catch {
      setImportError('Import failed — please try again.')
      setStage('preview')
    }
  }

  function resetToIdle() {
    setStage('idle')
    setRows([])
    setSupplierName('')
    setImportError(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  const validCount = rows.filter((r) => r.valid).length
  const skippedCount = rows.length - validCount

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-shell)' }}>
      {/* Header */}
      <header style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--bg-border)' }}>
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link
            href="/settings"
            className="flex items-center gap-1.5 text-sm transition-colors"
            style={{ color: 'var(--text-secondary)' }}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Settings
          </Link>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Rates &amp; pricing</h1>
          <p className="mt-1.5" style={{ color: 'var(--text-secondary)' }}>
            Import your historical rates so WorkA can quote accurately from day one.
          </p>
        </div>

        {/* ── Done state ──────────────────────────────────────────────── */}
        {stage === 'done' && (
          <div className="mb-6">
            <div className="rounded-xl px-5 py-5 flex items-start gap-4" style={{ background: 'rgba(76,175,80,0.15)', border: '1px solid rgba(76,175,80,0.3)' }}>
              <span className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center" style={{ background: 'rgba(76,175,80,0.2)' }}>
                <svg className="w-5 h-5" style={{ color: 'var(--status-green)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold" style={{ color: 'var(--status-green)' }}>
                  {validCount} rate{validCount !== 1 ? 's' : ''} saved to WorkA
                </p>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--status-green)' }}>
                  These rates are now active. WorkA will use them when quoting your next job.
                </p>
                {!process.env.NEXT_PUBLIC_SUPABASE_URL && (
                  <p className="mt-1.5 text-xs rounded px-2 py-1" style={{ color: 'var(--status-amber)', background: 'rgba(255,152,0,0.1)', border: '1px solid rgba(255,152,0,0.2)' }}>
                    Demo mode — rates are held in memory and will reset when the server restarts. Connect Supabase to persist them.
                  </p>
                )}
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={resetToIdle}
                    className="text-xs font-medium rounded-lg px-3 py-1.5 transition-colors"
                    style={{ color: 'var(--status-green)', border: '1px solid rgba(76,175,80,0.4)' }}
                  >
                    Import another file
                  </button>
                  <Link
                    href="/chat"
                    className="text-xs font-medium rounded-lg px-3 py-1.5 transition-colors"
                    style={{ color: '#fff', background: 'var(--orange-primary)' }}
                  >
                    Back to chat
                  </Link>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Upload section ───────────────────────────────────────────── */}
        {(stage === 'idle' || stage === 'preview' || stage === 'extracting') && (
          <section className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                Upload rate sheet
              </h2>
              <button
                onClick={downloadExampleCSV}
                className="flex items-center gap-1.5 text-xs font-medium transition-colors"
                style={{ color: 'var(--orange-primary)' }}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download template
              </button>
            </div>

            {importError && stage === 'idle' && (
              <p className="mb-3 text-xs rounded-lg px-3 py-2" style={{ color: 'var(--status-amber)', background: 'rgba(255,152,0,0.1)', border: '1px solid rgba(255,152,0,0.2)' }}>
                {importError}
              </p>
            )}

            <div className="rounded-xl px-5 py-4 mb-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)' }}>
              {/* Drop zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => inputRef.current?.click()}
                className="relative border-2 border-dashed rounded-xl cursor-pointer transition-colors flex flex-col items-center justify-center gap-2 py-8 px-4"
                style={dragOver
                  ? { borderColor: 'var(--orange-primary)', background: 'rgba(255,107,43,0.08)' }
                  : { borderColor: 'var(--bg-border)' }
                }
              >
                <svg
                  className="w-8 h-8"
                  style={{ color: dragOver ? 'var(--orange-primary)' : 'var(--text-tertiary)' }}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                </svg>
                <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {stage === 'preview' ? 'Drop another CSV to replace' : 'Drop your CSV here, or click to browse'}
                </p>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  CSV or PDF — past quotes, invoices, supplier price lists
                </p>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".csv,.pdf,text/csv,application/pdf"
                  className="sr-only"
                  onChange={handleInputChange}
                />
              </div>
            </div>
          </section>
        )}

        {/* ── Preview ──────────────────────────────────────────────────── */}
        {stage === 'preview' && rows.length > 0 && (
          <section className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                Preview
              </h2>
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                <span className="font-semibold" style={{ color: 'var(--status-green)' }}>{validCount} ready</span>
                {skippedCount > 0 && <span className="font-semibold" style={{ color: 'var(--status-amber)' }}> · {skippedCount} skipped</span>}
              </span>
            </div>

            <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)' }}>
              <div className="overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0" style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--bg-border)' }}>
                    <tr>
                      <th className="text-left font-medium px-4 py-2.5 w-8" style={{ color: 'var(--text-secondary)' }}></th>
                      <th className="text-left font-medium px-3 py-2.5" style={{ color: 'var(--text-secondary)' }}>Category</th>
                      <th className="text-left font-medium px-3 py-2.5" style={{ color: 'var(--text-secondary)' }}>Description</th>
                      <th className="text-left font-medium px-3 py-2.5" style={{ color: 'var(--text-secondary)' }}>Unit</th>
                      <th className="text-right font-medium px-4 py-2.5" style={{ color: 'var(--text-secondary)' }}>Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr
                        key={i}
                        style={row.valid
                          ? { borderTop: i > 0 ? '1px solid var(--bg-border)' : undefined }
                          : { background: 'rgba(255,152,0,0.07)', borderTop: i > 0 ? '1px solid var(--bg-border)' : undefined }
                        }
                      >
                        <td className="px-4 py-2 text-center">
                          {row.valid ? (
                            <span style={{ color: 'var(--status-green)' }}>
                              <svg className="w-3.5 h-3.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            </span>
                          ) : (
                            <span style={{ color: 'var(--status-amber)' }} title={row.error}>
                              <svg className="w-3.5 h-3.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                              </svg>
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 max-w-[140px] truncate" style={{ color: 'var(--text-primary)' }}>
                          {row.matched_category?.name ?? (
                            <span style={{ color: 'var(--status-amber)' }}>{row.raw_category}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 max-w-[200px] truncate" style={{ color: 'var(--text-primary)' }} title={row.description}>
                          {row.description}
                        </td>
                        <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>{row.unit}</td>
                        <td className="px-4 py-2 text-right font-medium tabular-nums" style={{ color: 'var(--text-primary)' }}>
                          {row.rate !== null ? `$${row.rate.toFixed(2)}` : <span style={{ color: 'var(--status-amber)' }}>—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {skippedCount > 0 && (
                <div className="px-4 py-2.5" style={{ borderTop: '1px solid rgba(255,152,0,0.2)', background: 'rgba(255,152,0,0.07)' }}>
                  <p className="text-xs" style={{ color: 'var(--status-amber)' }}>
                    {skippedCount} row{skippedCount !== 1 ? 's' : ''} skipped — unknown trade category or missing rate. Check the template for valid category names.
                  </p>
                </div>
              )}
            </div>

            {/* Supplier name + actions */}
            <div className="mt-4 rounded-xl px-5 py-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)' }}>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Label this import <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}>(optional)</span>
              </label>
              <input
                type="text"
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
                placeholder="e.g. Harvey Norman Trade, My 2024 rates"
                className="w-full text-sm rounded-lg px-3 py-2 focus:outline-none focus:ring-2"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--bg-border)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>

            {importError && (
              <p className="mt-3 text-xs rounded-lg px-3 py-2" style={{ color: 'var(--status-amber)', background: 'rgba(255,152,0,0.1)', border: '1px solid rgba(255,152,0,0.2)' }}>
                {importError}
              </p>
            )}

            <div id="import-actions" className="mt-4 rounded-xl px-5 py-4 flex items-center justify-between gap-4" style={{ background: 'var(--bg-surface)', border: '1px solid rgba(255,107,43,0.3)' }}>
              <div className="min-w-0">
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Ready to save {validCount} rate{validCount !== 1 ? 's' : ''}
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  {skippedCount > 0 ? `${skippedCount} row${skippedCount !== 1 ? 's' : ''} will be skipped — unknown category.` : 'All rows matched successfully.'}
                </p>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button
                  onClick={resetToIdle}
                  className="text-sm rounded-xl px-4 py-2 transition-colors"
                  style={{ color: 'var(--text-secondary)', border: '1px solid var(--bg-border)', background: 'transparent' }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleImport}
                  disabled={validCount === 0}
                  className="text-sm font-semibold rounded-xl px-5 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ color: '#fff', background: 'var(--orange-primary)' }}
                >
                  Save to WorkA
                </button>
              </div>
            </div>
          </section>
        )}

        {/* ── Extracting / Importing spinner ──────────────────────────── */}
        {(stage === 'extracting' || stage === 'importing') && (
          <div className="mb-6 rounded-xl px-5 py-6 flex items-center gap-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)' }}>
            <svg className="w-5 h-5 animate-spin flex-shrink-0" style={{ color: 'var(--orange-primary)' }} fill="none" viewBox="0 0 24 24" aria-hidden="true">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {stage === 'extracting' ? 'Reading PDF and extracting rates…' : `Importing ${validCount} rates…`}
            </span>
          </div>
        )}

        {/* ── Previously imported ──────────────────────────────────────── */}
        {!loadingExisting && existingRates.length > 0 && stage !== 'importing' && stage !== 'extracting' && (
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-tertiary)' }}>
              Previously imported ({existingRates.length})
            </h2>
            <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)' }}>
              <div className="overflow-x-auto max-h-56 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0" style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--bg-border)' }}>
                    <tr>
                      <th className="text-left font-medium px-4 py-2.5" style={{ color: 'var(--text-secondary)' }}>Source</th>
                      <th className="text-left font-medium px-3 py-2.5" style={{ color: 'var(--text-secondary)' }}>Item</th>
                      <th className="text-right font-medium px-4 py-2.5" style={{ color: 'var(--text-secondary)' }}>Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {existingRates.map((r, i) => (
                      <tr key={r.id} style={{ borderTop: i > 0 ? '1px solid var(--bg-border)' : undefined }}>
                        <td className="px-4 py-2 max-w-[120px] truncate" style={{ color: 'var(--text-secondary)' }}>{r.supplier_name}</td>
                        <td className="px-3 py-2 max-w-[220px] truncate" style={{ color: 'var(--text-primary)' }}>{r.line_item_key ?? r.id}</td>
                        <td className="px-4 py-2 text-right tabular-nums" style={{ color: 'var(--text-primary)' }}>{r.unit} · ${r.rate}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* ── How it works ─────────────────────────────────────────────── */}
        {stage !== 'preview' && stage !== 'importing' && stage !== 'extracting' && (
          <section className="mt-6">
            <div className="rounded-xl px-5 py-4" style={{ background: 'var(--bg-elevated)' }}>
              <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>How WorkA uses your rates</p>
              <ul className="space-y-1.5">
                {[
                  'Your imported rates are the first thing checked when pricing a new quote.',
                  'Rates are matched by trade category and line item description.',
                  'Where no match exists, WorkA falls back to Victorian state averages.',
                  'Rates learned from your approved quotes take priority over imports.',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <span className="flex-shrink-0 w-1 h-1 rounded-full mt-1.5" style={{ background: 'var(--text-tertiary)' }} aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
