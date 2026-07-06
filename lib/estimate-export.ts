// ─── Estimate exports (Stage 5) ───────────────────────────────────────────────
// Three deliverables from a GeneratedEstimate:
//   • Excel workbook — Summary / Detailed / Assumptions / PC & PS / Inclusions &
//     Exclusions. Subtotals, contingency, margin and GST are live FORMULAS
//     (never hardcoded); % drivers and cost inputs are blue, formulas black.
//   • Builder PDF (print-ready HTML) — cover summary, trade subtotals, terms.
//   • Client quotation (print-ready HTML) — grouped by area (not trade),
//     rounded, margin never shown as a line.
// All three carry the "Indicative / Budget-Range Only" header when indicative,
// and NO company/branding field is ever populated from anything but settings.

import { buildXlsx, type Sheet, type Cell } from './xlsx'
import { SECTION_BY_KEY, type GeneratedEstimate, type EstimateLineItem, type PricingMode } from './estimate-generation'

export interface ExportMeta {
  projectName: string
  address: string | null
  isIndicative: boolean
  /** ONLY from company settings — null stays null, never invented from documents */
  branding: { company_name: string | null; contact: string | null }
  assumptions: string[]
  exclusions: string[]
  risks: string[]
  pricingMode: PricingMode
}

const INDICATIVE_HEADER = 'INDICATIVE / BUDGET-RANGE ONLY — NOT TENDER-READY'

// ═══════════════════════════════════════════════════════════════════════════
// EXCEL WORKBOOK
// ═══════════════════════════════════════════════════════════════════════════

const DETAILED_SHEET = 'Detailed Estimate'

export function buildEstimateWorkbook(est: GeneratedEstimate, meta: ExportMeta): Buffer {
  return buildXlsx([
    summarySheet(est, meta),
    detailedSheet(est),
    assumptionsSheet(meta),
    pcpsSheet(est),
    inclusionsExclusionsSheet(est, meta),
  ])
}

// ── Detailed Estimate — the source of truth the Summary sums over ────────────
// Columns: A Code | B Section | C Description | D Location | E Basis | F Source |
//          G Qty | H Unit | I Rate | J Total(=G*I formula)
function detailedSheet(est: GeneratedEstimate): Sheet {
  const rows: Array<Array<Cell | string | number | null>> = []
  rows.push([
    { v: 'Code', style: 'header' }, { v: 'Section', style: 'header' }, { v: 'Description', style: 'header' },
    { v: 'Location', style: 'header' }, { v: 'Basis', style: 'header' }, { v: 'Source', style: 'header' },
    { v: 'Qty', style: 'header' }, { v: 'Unit', style: 'header' }, { v: 'Rate', style: 'header' }, { v: 'Total', style: 'header' },
  ])

  let n = 1
  for (const section of est.sections) {
    for (const it of section.items) {
      const r = rows.length + 1 // 1-based Excel row
      const hasQty = it.quantity !== null
      const hasRate = it.rate !== null
      const total: Cell =
        hasQty && hasRate
          ? { f: `G${r}*I${r}`, style: 'formulaCur' } // black formula
          : { v: it.total ?? '', style: 'formulaCur' }
      rows.push([
        { v: `${String(SECTION_BY_KEY[it.section]?.order ?? 0)}.${String(n).padStart(3, '0')}` },
        { v: it.section },
        { v: it.description },
        { v: it.location_scope },
        { v: it.basis },
        { v: it.source_ref ?? '' },
        { v: hasQty ? (it.quantity as number) : '', style: 'input' },     // blue input
        { v: it.unit ?? '' },
        { v: hasRate ? (it.rate as number) : '', style: 'inputCur' },     // blue input
        total,
      ])
      n++
    }
  }
  return {
    name: DETAILED_SHEET,
    rows,
    colWidths: [8, 16, 42, 16, 12, 14, 8, 7, 12, 14],
  }
}

// ── Summary — section subtotals via SUMIF over Detailed, then the roll-up ─────
function summarySheet(est: GeneratedEstimate, meta: ExportMeta): Sheet {
  const t = est.totals
  const rows: Array<Array<Cell | string | number | null>> = []
  rows.push([{ v: meta.branding.company_name ?? 'Estimate', style: 'title' }])
  if (meta.isIndicative) rows.push([{ v: INDICATIVE_HEADER, style: 'header' }])
  rows.push([{ v: meta.projectName, style: 'header' }])
  if (meta.address) rows.push([{ v: meta.address, style: 'muted' }])
  rows.push([{ v: `Pricing basis: ${meta.pricingMode === 'user_supplied' ? 'your rate library' : 'market rates (indicative)'}`, style: 'muted' }])
  rows.push([])
  rows.push([{ v: 'Section', style: 'header' }, { v: 'Subtotal (cost)', style: 'header' }])

  const firstSectionRow = rows.length + 1
  for (const s of est.sections) {
    const r = rows.length + 1
    rows.push([
      { v: s.label },
      // SUMIF over the Detailed sheet — live, not a pasted number.
      { f: `SUMIF('${DETAILED_SHEET}'!$B:$B,"${s.key}",'${DETAILED_SHEET}'!$J:$J)`, style: 'formulaCur' },
    ])
    void r
  }
  const lastSectionRow = rows.length

  rows.push([])
  const subtotalRow = rows.length + 1
  rows.push([{ v: 'Trade subtotal (ex GST)', style: 'header' }, { f: `SUM(B${firstSectionRow}:B${lastSectionRow})`, style: 'totalCur' }])

  const contRow = rows.length + 1
  rows.push([{ v: 'Contingency', style: 'default' }, { f: `B${subtotalRow}*C${contRow}`, style: 'formulaCur' }, { v: t.contingency_pct / 100, style: 'pct' }])

  const marginRow = rows.length + 1
  rows.push([{ v: 'Margin', style: 'default' }, { f: `(B${subtotalRow}+B${contRow})*C${marginRow}`, style: 'formulaCur' }, { v: t.margin_pct / 100, style: 'pct' }])

  const exRow = rows.length + 1
  rows.push([{ v: 'Total ex GST', style: 'header' }, { f: `B${subtotalRow}+B${contRow}+B${marginRow}`, style: 'totalCur' }])

  const gstRow = rows.length + 1
  rows.push([{ v: 'GST', style: 'default' }, { f: `B${exRow}*C${gstRow}`, style: 'formulaCur' }, { v: t.gst_pct / 100, style: 'pct' }])

  rows.push([{ v: 'Total inc GST', style: 'header' }, { f: `B${exRow}+B${gstRow}`, style: 'totalCur' }])

  rows.push([])
  rows.push([{ v: `${est.line_count} line items · contingency/margin/GST are formulas (blue cells are inputs you can edit)`, style: 'muted' }])

  return { name: 'Summary', rows, colWidths: [32, 18, 10] }
}

function assumptionsSheet(meta: ExportMeta): Sheet {
  const rows: Array<Array<Cell | string | number | null>> = []
  rows.push([{ v: 'Assumptions & Risks', style: 'title' }])
  rows.push([])
  rows.push([{ v: 'Assumptions', style: 'header' }])
  for (const a of meta.assumptions.length ? meta.assumptions : ['—']) rows.push([{ v: a }])
  rows.push([])
  rows.push([{ v: 'Risks / gaps', style: 'header' }])
  for (const r of meta.risks.length ? meta.risks : ['—']) rows.push([{ v: r }])
  return { name: 'Assumptions', rows, colWidths: [90] }
}

function pcpsSheet(est: GeneratedEstimate): Sheet {
  const rows: Array<Array<Cell | string | number | null>> = []
  rows.push([{ v: 'PC & PS Schedule', style: 'title' }])
  rows.push([])
  rows.push([{ v: 'Type', style: 'header' }, { v: 'Section', style: 'header' }, { v: 'Description', style: 'header' }, { v: 'Amount', style: 'header' }])
  for (const s of est.sections) {
    for (const it of s.items) {
      if (it.basis !== 'pc_sum' && it.basis !== 'provisional') continue
      rows.push([
        { v: it.basis === 'pc_sum' ? 'PC Sum' : 'Provisional' },
        { v: s.label },
        { v: it.description },
        { v: it.total ?? '', style: 'formulaCur' },
      ])
    }
  }
  return { name: 'PC & PS Schedule', rows, colWidths: [14, 20, 44, 14] }
}

function inclusionsExclusionsSheet(est: GeneratedEstimate, meta: ExportMeta): Sheet {
  const rows: Array<Array<Cell | string | number | null>> = []
  rows.push([{ v: 'Inclusions & Exclusions', style: 'title' }])
  rows.push([])
  rows.push([{ v: 'Included (priced sections)', style: 'header' }])
  for (const s of est.sections) rows.push([{ v: s.label }])
  rows.push([])
  rows.push([{ v: 'Exclusions', style: 'header' }])
  for (const e of meta.exclusions.length ? meta.exclusions : ['—']) rows.push([{ v: e }])
  return { name: 'Inclusions & Exclusions', rows, colWidths: [60] }
}

// ═══════════════════════════════════════════════════════════════════════════
// HTML EXPORTS (builder PDF + client quotation) — print-ready
// ═══════════════════════════════════════════════════════════════════════════

const aud = (n: number) => `$${Math.round(n).toLocaleString('en-AU')}`

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function indicativeBar(meta: ExportMeta): string {
  if (!meta.isIndicative) return ''
  return `<div class="indicative">${INDICATIVE_HEADER}</div>`
}

const PRINT_CSS = `
* { box-sizing: border-box; }
body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 32px; }
h1 { font-size: 22px; margin: 0 0 2px; }
h2 { font-size: 15px; margin: 24px 0 8px; border-bottom: 2px solid #eee; padding-bottom: 4px; }
.muted { color: #6b7280; font-size: 12px; }
.indicative { background: #fff4e5; border: 1px solid #ff9800; color: #b45309; font-weight: 700; text-align: center; padding: 10px; border-radius: 8px; margin: 0 0 20px; letter-spacing: .03em; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 12px; }
th, td { text-align: left; padding: 6px 8px; font-size: 12px; border-bottom: 1px solid #f0f0f0; }
th { color: #6b7280; text-transform: uppercase; font-size: 10px; letter-spacing: .04em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.section-subtotal td { font-weight: 700; border-top: 1px solid #ddd; }
.rollup { max-width: 360px; margin-left: auto; }
.rollup td { border: none; padding: 3px 8px; }
.rollup .total td { font-weight: 700; border-top: 2px solid #333; font-size: 14px; }
.basis { display: inline-block; font-size: 9px; font-weight: 700; text-transform: uppercase; padding: 1px 5px; border-radius: 4px; }
.b-measured { background: #e8f5e9; color: #2e7d32; } .b-allowance { background: #e3f2fd; color: #1565c0; }
.b-pc_sum { background: #fff3e0; color: #e65100; } .b-provisional { background: #ffebee; color: #c62828; }
.terms li { font-size: 12px; margin-bottom: 4px; color: #333; }
@media print { body { padding: 0; } h2 { page-break-after: avoid; } tr { page-break-inside: avoid; } }
`

// ── Builder PDF — itemised, trade-grouped ────────────────────────────────────
export function buildBuilderHtml(est: GeneratedEstimate, meta: ExportMeta): string {
  const t = est.totals
  const sections = est.sections
    .map((s) => {
      const lines = s.items
        .map(
          (it) => `<tr>
<td>${escapeHtml(it.description)}${it.source_ref ? ` <span class="muted">${escapeHtml(it.source_ref)}</span>` : ''}</td>
<td><span class="basis b-${it.basis}">${it.basis.replace('_', ' ')}</span></td>
<td class="num">${it.quantity !== null ? `${it.quantity} ${escapeHtml(it.unit ?? '')}` : ''}</td>
<td class="num">${it.rate !== null ? aud(it.rate) : ''}</td>
<td class="num">${it.total !== null ? aud(it.total) : '—'}</td>
</tr>`
        )
        .join('')
      return `<h2>${escapeHtml(s.label)}</h2>
<table><thead><tr><th>Description</th><th>Basis</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Total</th></tr></thead>
<tbody>${lines}<tr class="section-subtotal"><td colspan="4">Section subtotal</td><td class="num">${aud(s.subtotal)}</td></tr></tbody></table>`
    })
    .join('')

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(meta.projectName)} — Estimate</title><style>${PRINT_CSS}</style></head>
<body>
${indicativeBar(meta)}
${meta.branding.company_name ? `<p class="muted">${escapeHtml(meta.branding.company_name)}</p>` : ''}
<h1>${escapeHtml(meta.projectName)}</h1>
<p class="muted">${meta.address ? escapeHtml(meta.address) + ' · ' : ''}${est.line_count} line items · ${meta.pricingMode === 'user_supplied' ? 'your rate library' : 'market rates (indicative)'}</p>
${sections}
<h2>Estimate roll-up</h2>
<table class="rollup">
<tr><td>Trade subtotal (ex GST)</td><td class="num">${aud(t.trade_subtotal)}</td></tr>
<tr><td>Contingency (${t.contingency_pct}%)</td><td class="num">${aud(t.contingency_amount)}</td></tr>
<tr><td>Margin (${t.margin_pct}%)</td><td class="num">${aud(t.margin_amount)}</td></tr>
<tr><td>Total ex GST</td><td class="num">${aud(t.total_ex_gst)}</td></tr>
<tr><td>GST (${t.gst_pct}%)</td><td class="num">${aud(t.gst_amount)}</td></tr>
<tr class="total"><td>Total inc GST</td><td class="num">${aud(t.total_inc_gst)}</td></tr>
</table>
${termsBlock(meta)}
</body></html>`
}

function termsBlock(meta: ExportMeta): string {
  const parts: string[] = []
  if (meta.assumptions.length) parts.push(`<h2>Assumptions</h2><ul class="terms">${meta.assumptions.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`)
  if (meta.risks.length) parts.push(`<h2>Risks / gaps</h2><ul class="terms">${meta.risks.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`)
  if (meta.exclusions.length) parts.push(`<h2>Exclusions</h2><ul class="terms">${meta.exclusions.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`)
  return parts.join('')
}

// ── Client quotation — grouped by AREA, rounded, margin never shown ──────────
const AREA_LABEL: Record<string, string> = {
  primary: 'Main residence',
  secondary_dwelling: 'Secondary dwelling',
  pool: 'Pool & surrounds',
  external: 'External works & landscaping',
  general: 'Preliminaries & general',
}
const AREA_ORDER = ['primary', 'secondary_dwelling', 'pool', 'external', 'general']

export function buildClientQuoteHtml(est: GeneratedEstimate, meta: ExportMeta): string {
  const t = est.totals
  // Client price grosses cost by contingency + margin (margin never itemised),
  // then rounds. GST shown as one line. All figures rounded to the nearest $500.
  const gross = (cost: number) => cost * (1 + t.contingency_pct / 100) * (1 + t.margin_pct / 100)
  const round500 = (n: number) => Math.round(n / 500) * 500

  const allItems = est.sections.flatMap((s) => s.items)
  const areas = AREA_ORDER.map((area) => {
    const items = allItems.filter((i) => i.location_scope === area)
    if (items.length === 0) return ''
    const cost = items.reduce((sum, i) => sum + (i.total ?? 0), 0)
    const sell = round500(gross(cost))
    // Simplified descriptions grouped by section within the area.
    const bySection = new Map<string, EstimateLineItem[]>()
    for (const i of items) {
      const arr = bySection.get(i.section) ?? []
      arr.push(i)
      bySection.set(i.section, arr)
    }
    const lines = Array.from(bySection.keys())
      .map((key) => `<li>${escapeHtml(SECTION_BY_KEY[key]?.label ?? key)}</li>`)
      .join('')
    return `<h2>${escapeHtml(AREA_LABEL[area] ?? area)} — ${aud(sell)}</h2><ul class="terms">${lines}</ul>`
  }).join('')

  const totalSell = round500(gross(t.trade_subtotal))
  const gst = totalSell * (t.gst_pct / 100)

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(meta.projectName)} — Quotation</title><style>${PRINT_CSS}</style></head>
<body>
${indicativeBar(meta)}
${meta.branding.company_name ? `<h1>${escapeHtml(meta.branding.company_name)}</h1>` : ''}
<p class="muted">Quotation${meta.branding.contact ? ' · ' + escapeHtml(meta.branding.contact) : ''}</p>
<h1>${escapeHtml(meta.projectName)}</h1>
<p class="muted">${meta.address ? escapeHtml(meta.address) : ''}</p>
${areas}
<h2>Total</h2>
<table class="rollup">
<tr><td>Subtotal</td><td class="num">${aud(totalSell)}</td></tr>
<tr><td>GST (${t.gst_pct}%)</td><td class="num">${aud(gst)}</td></tr>
<tr class="total"><td>Total inc GST</td><td class="num">${aud(totalSell + gst)}</td></tr>
</table>
${meta.exclusions.length ? `<h2>Exclusions</h2><ul class="terms">${meta.exclusions.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}
<p class="muted">${meta.isIndicative ? 'This is an indicative budget-range quotation and is not a fixed-price offer. ' : ''}Prices are rounded and inclusive of builder's margin.</p>
</body></html>`
}
