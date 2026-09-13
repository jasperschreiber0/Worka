import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { intelligenceDB, fingerprint } from '@/lib/profitability-data'
import { parseCSV, mapCostRows, COST_CATEGORIES } from '@/lib/cost-import'
export const runtime = 'nodejs'
async function access(job: string) {
  const builder = await getAuthenticatedBuilderId()
  if (!builder) throw new Error('Unauthorized')
  if (isDemoMode()) throw new Error('Connect your account to import actual costs')
  const db = intelligenceDB()
  const r = await db
    .from('jobs')
    .select('id,address')
    .eq('id', job)
    .eq('builder_id', builder)
    .maybeSingle()
  if (r.error) throw r.error
  if (!r.data) throw new Error('Job not found')
  return { builder, db, job: r.data }
}
export async function POST(req: NextRequest, { params }: { params: { jobId: string } }) {
  try {
    await access(params.jobId)
    const form = await req.formData(),
      file = form.get('file') as File | null
    if (!file || file.size > 2 * 1024 * 1024)
      throw new Error('Choose a CSV or XLSX file up to 2 MB')
    const sheets: { name: string; rows: string[][] }[] = []
    if (/\.(csv|tsv)$/i.test(file.name))
      sheets.push({ name: 'Costs', rows: parseCSV(await file.text()) })
    else if (/\.xlsx$/i.test(file.name)) {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(await file.arrayBuffer())
      if (workbook.worksheets.length > 20) throw new Error('Workbook has more than 20 sheets')
      workbook.eachSheet((sheet) => {
        if (sheet.rowCount > 2100 || sheet.columnCount > 100)
          throw new Error('Use a sheet with up to 2,000 cost rows and 100 columns')
        const rows: string[][] = []
        sheet.eachRow({ includeEmpty: true }, (row) => {
          const values: string[] = []
          for (let c = 1; c <= sheet.columnCount; c++) {
            const v = row.getCell(c).value
            values.push(
              v instanceof Date
                ? v.toISOString().slice(0, 10)
                : v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)
                  ? '[FORMULA — replace with a verified value]'
                  : v && typeof v === 'object' && 'richText' in v
                    ? v.richText.map((t) => t.text).join('')
                    : v && typeof v === 'object'
                      ? '[UNSUPPORTED CELL]'
                      : String(v ?? ''),
            )
          }
          rows.push(values)
        })
        sheets.push({ name: sheet.name, rows })
      })
    } else throw new Error('Choose CSV, TSV or XLSX')
    if (sheets.some((s) => s.rows.length > 2100 || s.rows.some((r) => r.length > 100)))
      throw new Error('Maximum 2,000 cost rows and 100 columns')
    return NextResponse.json({ sheets, name: file.name })
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: (e as Error).message === 'Unauthorized' ? 401 : 400 },
    )
  }
}
export async function PUT(req: NextRequest, { params }: { params: { jobId: string } }) {
  try {
    const { builder, db } = await access(params.jobId)
    const body = await req.json()
    if (body.confirmed !== true || body.labourReconciled !== true)
      throw new Error('Confirm the mapping, amounts and labour duplication check')
    if (
      !Array.isArray(body.rows) ||
      body.rows.length > 2000 ||
      !body.rows.every((r: unknown) => Array.isArray(r) && r.every((c) => typeof c === 'string'))
    )
      throw new Error('Invalid import rows')
    const mapped = mapCostRows(body.rows, body.mapping, body.options)
    if (mapped.some((r) => r.error))
      throw new Error('Resolve every rejected row before importing; no rows were saved')
    const rows = mapped.map((r, index) => {
      const override = body.classifications?.[index]
      if (
        override &&
        ((override.trade !== null &&
          (!Number.isInteger(override.trade) || override.trade < 1 || override.trade > 13)) ||
          !COST_CATEGORIES.includes(override.category))
      )
        throw new Error('Invalid classification')
      return {
        ...r.entry,
        ...(override
          ? {
              trade_category_id: override.trade,
              category: override.category,
              classification_confidence: 1,
            }
          : {}),
        source_row: r.row,
        import_metadata: { raw: r.raw, original: r.entry, approved: true },
      }
    })
    // Same source rows cannot be imported twice by changing the mapping or file name.
    const hash = fingerprint(body.rows)
    const result = await db.rpc('import_profitability_costs', {
      p_builder: builder,
      p_job: params.jobId,
      p_fingerprint: hash,
      p_name: String(body.name ?? 'Spreadsheet').slice(0, 200),
      p_mapping: { mapping: body.mapping, options: body.options },
      p_rows: rows,
    })
    if (result.error)
      throw new Error(
        result.error.code === '23505'
          ? 'This spreadsheet has already been imported for this job'
          : result.error.message,
      )
    return NextResponse.json({ ok: true, count: rows.length })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
