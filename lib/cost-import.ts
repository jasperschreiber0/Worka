import { amount, roundMoney } from './profitability.ts'
export const COST_CATEGORIES = [
  'preliminaries',
  'demolition',
  'earthworks',
  'excavation',
  'concrete',
  'structural steel',
  'carpentry',
  'framing',
  'roofing',
  'windows',
  'glazing',
  'plumbing',
  'electrical',
  'HVAC',
  'insulation',
  'plasterboard',
  'waterproofing',
  'tiling',
  'joinery',
  'painting',
  'flooring',
  'fixtures',
  'appliances',
  'landscaping',
  'external works',
  'labour',
  'supervision',
  'plant',
  'waste',
  'consultants',
  'permits',
  'subcontractors',
  'miscellaneous',
] as const
export const CATEGORY_TRADE: Record<string, number | null> = {
  preliminaries: 13,
  demolition: 1,
  earthworks: 1,
  excavation: 1,
  concrete: 1,
  'structural steel': 2,
  carpentry: 7,
  framing: 2,
  roofing: 3,
  windows: null,
  glazing: null,
  plumbing: null,
  electrical: 12,
  HVAC: null,
  insulation: 5,
  plasterboard: 6,
  waterproofing: 10,
  tiling: 10,
  joinery: 8,
  painting: 9,
  flooring: 10,
  fixtures: 11,
  appliances: 11,
  landscaping: 1,
  'external works': 1,
  labour: null,
  supervision: 13,
  plant: 13,
  waste: 13,
  consultants: 13,
  permits: 13,
  subcontractors: null,
  miscellaneous: null,
}
export const IMPORT_FIELDS = [
  'description',
  'amount',
  'supplier',
  'invoice',
  'category',
  'costCode',
  'date',
  'hours',
  'labourCost',
  'project',
] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]
export type ColumnMapping = Record<ImportField, number>
export function suggestMapping(headers: string[]): ColumnMapping {
  const aliases: Record<ImportField, string[]> = {
    description: ['description', 'details', 'memo', 'item'],
    amount: ['amount', 'total', 'cost', 'net amount', 'net', 'debit'],
    supplier: ['supplier', 'subcontractor', 'vendor', 'contact'],
    invoice: ['invoice', 'invoice number', 'invoice no', 'reference'],
    category: ['trade', 'category'],
    costCode: ['cost code', 'code'],
    date: ['date', 'invoice date'],
    hours: ['hours', 'labour hours', 'labor hours'],
    labourCost: ['labour cost', 'labor cost'],
    project: ['project', 'job', 'job name'],
  }
  return Object.fromEntries(
    IMPORT_FIELDS.map((f) => [
      f,
      headers.findIndex((h) => aliases[f].includes(h.trim().toLowerCase())),
    ]),
  ) as ColumnMapping
}
export function parseCSV(text: string): string[][] {
  const lines: string[][] = []
  let row: string[] = [],
    cell = '',
    quoted = false
  const first = text.split(/\r?\n/, 1)[0]
  const delimiter =
    (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length
      ? '\t'
      : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length
        ? ';'
        : ','
  text = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = !quoted
    } else if (c === delimiter && !quoted) {
      row.push(cell)
      cell = ''
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      if (row.some((v) => v.trim())) lines.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (quoted) throw new Error('CSV has an unclosed quote')
  row.push(cell)
  if (row.some((v) => v.trim())) lines.push(row)
  return lines
}
export function parseAmount(text: string, required = true): number | null {
  let s = text.trim()
  if (!s) {
    if (required) throw new Error('Amount is missing')
    return null
  }
  if (/^\(.*\)$/.test(s)) s = '-' + s.slice(1, -1)
  s = s.replace(/^(AUD\s*|\$)/i, '').trim()
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,4})?$/.test(s)) throw new Error(`Invalid numeric value: ${text}`)
  s=s.replace(/,/g,'')
  return amount(Number(s), 'Cost', -999999999)
}
export function parseDate(text: string): string {
  let s = text.trim()
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (m) s = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    new Date(s).toISOString().slice(0, 10) !== s
  )
    throw new Error('Date must be a real date in DD/MM/YYYY or YYYY-MM-DD format')
  return s
}
export interface ImportOptions {
  taxBasis: '' | 'exclusive' | 'inclusive'
  labourBasis: 'included' | 'additional'
  defaultDate: string
  projectLabel: string
}
export function mapCostRows(rows: string[][], mapping: ColumnMapping, options: ImportOptions) {
  if (mapping.description < 0 || mapping.amount < 0)
    throw new Error('Map Description and Amount before importing')
  if (
    !['exclusive', 'inclusive'].includes(options.taxBasis) ||
    !['included', 'additional'].includes(options.labourBasis)
  )
    throw new Error('Confirm GST and labour basis')
  parseDate(options.defaultDate)
  return rows.map((raw, index) => {
    const read = (f: ImportField) => (raw[mapping[f]] ?? '').trim()
    try {
      const description = read('description')
      if (!description) throw new Error('Description is missing')
      if (
        read('project') &&
        read('project').toLowerCase() !== options.projectLabel.trim().toLowerCase()
      )
        throw new Error('Project differs from selected job — review this row')
      const base = parseAmount(read('amount'))!,
        labour = parseAmount(read('labourCost'), false),
        hours = parseAmount(read('hours'), false)
      const factor = options.taxBasis === 'inclusive' ? 1 / 1.1 : 1
      if (hours !== null && hours < 0) throw new Error('Labour hours cannot be negative; correct the source hours separately')
      const total = roundMoney(
        (base + (options.labourBasis === 'additional' ? (labour ?? 0) : 0)) * factor,
      )
      if (options.labourBasis === 'included' && labour !== null && (Math.abs(labour) > Math.abs(base) || (labour !== 0 && Math.sign(labour) !== Math.sign(base))))
        throw new Error('Labour exceeds the total amount')
      const category = read('category').toLowerCase()
      const known =
        COST_CATEGORIES.find((c) => c.toLowerCase() === category) ??
        COST_CATEGORIES.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(description))
      return {
        row: index + 2,
        raw,
        error: null,
        entry: {
          description,
          amount: total,
          supplier: read('supplier') || null,
          invoice_ref: read('invoice') || null,
          category: known ?? 'miscellaneous',
          cost_code: read('costCode') || null,
          trade_category_id: known ? CATEGORY_TRADE[known] : null,
          incurred_on: parseDate(read('date') || options.defaultDate),
          labour_hours: hours,
          labour_cost: labour === null ? null : roundMoney(labour * factor),
          classification_confidence: known?.toLowerCase() === category ? 1 : known ? 0.5 : 0,
          original_amount: base,
          tax_basis: options.taxBasis,
          labour_basis: options.labourBasis,
        },
      }
    } catch (e) {
      return { row: index + 2, raw, error: (e as Error).message, entry: null }
    }
  })
}
