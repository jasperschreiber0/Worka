'use client'

import { useState, useRef, useCallback } from 'react'
import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExtractedRate {
  trade_category_id: number
  trade_category_name: string
  description: string
  unit: string
  rate: number
}

type Stage = 'idle' | 'extracting' | 'preview' | 'done'

// ─── Trade category keyword map for CSV fuzzy matching ────────────────────────

const CATEGORY_KEYWORDS: Array<{ id: number; name: string; keywords: string[] }> = [
  { id: 1,  name: 'Earthworks & Site Prep', keywords: ['earth', 'excavat', 'site prep', 'fill', 'compac', 'drain', 'retaining'] },
  { id: 2,  name: 'Concrete',               keywords: ['concrete', 'slab', 'footing', 'paver', 'cement', 'reinforce', 'reo', 'pour'] },
  { id: 3,  name: 'Framing & Structural',   keywords: ['frame', 'stud', 'joist', 'truss', 'struct', 'timber', 'steel beam', 'lbp', 'lintel'] },
  { id: 4,  name: 'Roofing',               keywords: ['roof', 'gutter', 'downpipe', 'colorbond', 'tile', 'ridge', 'fascia'] },
  { id: 5,  name: 'Windows & External Doors', keywords: ['window', 'door', 'glazing', 'aluminium', 'sliding'] },
  { id: 6,  name: 'External Cladding',     keywords: ['clad', 'render', 'brick', 'weatherboard', 'external wall', 'facade'] },
  { id: 7,  name: 'Insulation',            keywords: ['insul', 'batts', 'r-value', 'sarking'] },
  { id: 8,  name: 'Internal Linings',      keywords: ['plaster', 'gyproc', 'gyprock', 'lining', 'cornices', 'set', 'internal wall'] },
  { id: 9,  name: 'Joinery & Cabinetry',   keywords: ['joiner', 'cabinet', 'kitchen', 'vanity', 'wardrobe', 'bench', 'shelv'] },
  { id: 10, name: 'Painting',              keywords: ['paint', 'coat', 'primer', 'sealer', 'stain', 'varnish'] },
  { id: 11, name: 'Plumbing',              keywords: ['plumb', 'pipe', 'hot water', 'tap', 'toilet', 'basin', 'shower', 'waste'] },
  { id: 12, name: 'Electrical',            keywords: ['electr', 'gpo', 'power point', 'light', 'switch', 'board', 'circuit', 'cable', 'led'] },
  { id: 13, name: 'Tiling & Finishes',     keywords: ['tile', 'grout', 'floor finish', 'carpet', 'timber floor', 'vinyl', 'floating'] },
]

function guessCategory(text: string): { id: number; name: string } {
  const lower = text.toLowerCase()
  for (const cat of CATEGORY_KEYWORDS) {
    if (cat.keywords.some((kw) => lower.includes(kw))) {
      return { id: cat.id, name: cat.name }
    }
  }
  return { id: 1, name: 'Earthworks & Site Prep' }
}

// ─── CSV parser (handles quoted fields) ──────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else inQuotes = !inQuotes
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

function parseCSV(text: string): ExtractedRate[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return []
  const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase())
  const descIdx   = headers.findIndex((h) => h.includes('desc') || h.includes('item') || h.includes('name'))
  const unitIdx   = headers.findIndex((h) => h.includes('unit'))
  const rateIdx   = headers.findIndex((h) => h.includes('rate') || h.includes('price') || h.includes('cost'))
  const catIdx    = headers.findIndex((h) => h.includes('category') || h.includes('trade'))

  const rates: ExtractedRate[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i])
    const description = descIdx >= 0 ? cols[descIdx] ?? '' : cols[0] ?? ''
    const unit        = unitIdx >= 0 ? cols[unitIdx] ?? 'ea' : 'ea'
    const rateRaw     = rateIdx >= 0 ? cols[rateIdx] ?? '0' : cols[cols.length - 1] ?? '0'
    const rate        = parseFloat(rateRaw.replace(/[^0-9.]/g, ''))
    if (!description || isNaN(rate) || rate <= 0) continue

    let category: { id: number; name: string }
    if (catIdx >= 0 && cols[catIdx]) {
      category = guessCategory(cols[catIdx])
    } else {
      category = guessCategory(description)
    }

    rates.push({
      trade_category_id: category.id,
      trade_category_name: category.name,
      description,
      unit: unit || 'ea',
      rate,
    })
  }
  return rates
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function RatesPage() {
  const [stage, setStage] = useState<Stage>('idle')
  const [isImporting, setIsImporting] = useState(false)
  const [rates, setRates] = useState<ExtractedRate[]>([])
  const [supplierName, setSupplierName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [importedCount, setImportedCount] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const processFile = useCallback(async (file: File) => {
    setError(null)
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    const isCsv = file.type === 'text/csv' || file.name.toLowerCase().endsWith('.csv')

    if (!isPdf && !isCsv) {
      setError('Please upload a CSV or PDF file.')
      return
    }

    setStage('extracting')

    try {
      if (isCsv) {
        const text = await file.text()
        const parsed = parseCSV(text)
        if (!parsed.length) { setError('No valid rates found in CSV. Check column headers include: description, unit, rate.'); setStage('idle'); return }
        setRates(parsed)
        setSupplierName(file.name.replace(/\.[^.]+$/, ''))
        setStage('preview')
      } else {
        // PDF — send to extract-pdf API
        const formData = new FormData()
        formData.append('file', file)
        const res = await fetch('/api/rates/extract-pdf', { method: 'POST', body: formData })
        const data = await res.json() as { rates?: ExtractedRate[]; error?: string; demo?: boolean }
        if (!res.ok || data.error) { setError(data.error ?? 'PDF extraction failed.'); setStage('idle'); return }
        if (!data.rates?.length) { setError('No rates found in this PDF.'); setStage('idle'); return }
        setRates(data.rates)
        setSupplierName(file.name.replace(/\.[^.]+$/, ''))
        setStage('preview')
      }
    } catch {
      setError('Failed to process file. Please try again.')
      setStage('idle')
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) processFile(file)
  }, [processFile])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) processFile(file)
  }, [processFile])

  const handleImport = useCallback(async () => {
    if (!rates.length) return
    setIsImporting(true)
    try {
      const res = await fetch('/api/rates/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplier_name: supplierName || 'Imported', rates }),
      })
      const data = await res.json() as { imported?: number; error?: string }
      if (!res.ok || data.error) { setError(data.error ?? 'Import failed.'); setIsImporting(false); return }
      setImportedCount(data.imported ?? rates.length)
      setStage('done')
    } catch {
      setError('Import failed. Please try again.')
      setIsImporting(false)
    }
  }, [rates, supplierName])

  const handleReset = () => { setStage('idle'); setIsImporting(false); setRates([]); setError(null); setSupplierName('') }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link href="/settings" className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Settings
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Rates & pricing</h1>
          <p className="mt-1.5 text-sm text-slate-500">
            Upload past quotes or invoices to teach WorkA your rates. Supports CSV and PDF.
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Done state */}
        {stage === 'done' ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
            </div>
            <p className="text-lg font-semibold text-slate-900 mb-1">{importedCount} rates imported</p>
            <p className="text-sm text-slate-500 mb-6">WorkA will use these rates when quoting your next job.</p>
            <button type="button" onClick={handleReset} className="btn-secondary text-sm px-4 py-2">
              Upload another file
            </button>
          </div>
        ) : stage === 'preview' ? (
          /* Preview table */
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Preview — {rates.length} rates extracted</p>
                  <p className="text-xs text-slate-500 mt-0.5">Review before importing</p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={supplierName}
                    onChange={(e) => setSupplierName(e.target.value)}
                    placeholder="Supplier / file name"
                    className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
              </div>
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="text-left px-4 py-2 text-slate-500 font-medium">Category</th>
                      <th className="text-left px-4 py-2 text-slate-500 font-medium">Description</th>
                      <th className="text-left px-4 py-2 text-slate-500 font-medium">Unit</th>
                      <th className="text-right px-4 py-2 text-slate-500 font-medium">Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rates.map((r, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-4 py-2 text-slate-500 whitespace-nowrap">{r.trade_category_name}</td>
                        <td className="px-4 py-2 text-slate-900">{r.description}</td>
                        <td className="px-4 py-2 text-slate-500 whitespace-nowrap">{r.unit}</td>
                        <td className="px-4 py-2 text-slate-900 text-right whitespace-nowrap font-medium">
                          ${r.rate.toLocaleString('en-AU')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex gap-2 justify-end">
              <button type="button" onClick={handleReset} className="btn-secondary text-sm px-4 py-2">
                Cancel
              </button>
              <button
                type="button"
                onClick={handleImport}
                disabled={isImporting}
                className="btn-primary text-sm px-6 py-2 disabled:opacity-50"
              >
                {isImporting ? 'Importing…' : `Import ${rates.length} rates`}
              </button>
            </div>
          </div>
        ) : (
          /* Upload zone */
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`bg-white rounded-xl border-2 border-dashed cursor-pointer transition-colors p-12 text-center ${
              isDragging ? 'border-brand-400 bg-brand-50' : 'border-slate-300 hover:border-brand-400 hover:bg-slate-50'
            }`}
          >
            {stage === 'extracting' ? (
              <div className="flex flex-col items-center gap-3">
                <div className="w-10 h-10 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm font-medium text-slate-700">Extracting rates…</p>
              </div>
            ) : (
              <>
                <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-6 h-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-slate-700 mb-1">Drop a CSV or PDF here</p>
                <p className="text-xs text-slate-400">or click to browse</p>
                <p className="text-xs text-slate-400 mt-3">
                  CSV: columns for description, unit, rate &nbsp;·&nbsp; PDF: past quotes or invoices
                </p>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.pdf,text/csv,application/pdf"
              onChange={handleFileInput}
              className="sr-only"
            />
          </div>
        )}
      </main>
    </div>
  )
}
