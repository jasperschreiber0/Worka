// ─── Minimal dependency-free .xlsx writer (Stage 5) ───────────────────────────
// Emits a real OOXML spreadsheet — with live formulas and cell styling — without
// any third-party dependency. The brief requires formulas for subtotals/margin/
// GST (not hardcoded), a blue = input / black = formula convention, and a
// recalculation pass; a CSV can't do any of that. We build the XML parts and pack
// them into a ZIP (store method) using Node's Buffer + a hand-rolled CRC32, and
// set fullCalcOnLoad so Excel recomputes every formula on open (→ zero stale
// values). Verified by unzipping the output and inspecting the sheet XML.

// ─── Cell / sheet model ───────────────────────────────────────────────────────

export type CellStyle =
  | 'default'
  | 'header'      // bold
  | 'title'       // large bold
  | 'input'       // blue — a hardcoded input value
  | 'inputCur'    // blue currency — a hardcoded cost input
  | 'formulaCur'  // black currency — a computed/formula value
  | 'totalCur'    // bold black currency — a total
  | 'muted'       // grey small
  | 'pct'         // blue percent input

export interface Cell {
  /** literal value (string or number). Ignored when `f` is set (formula). */
  v?: string | number
  /** an Excel formula WITHOUT the leading "=" e.g. "SUM(D2:D9)" */
  f?: string
  style?: CellStyle
}

export interface Sheet {
  name: string
  rows: Array<Array<Cell | string | number | null>>
  /** column widths (in Excel width units), by column index */
  colWidths?: number[]
}

// ─── Style registry (index order MUST match styles.xml cellXfs below) ─────────

const STYLE_INDEX: Record<CellStyle, number> = {
  default: 0,
  header: 1,
  title: 2,
  input: 3,
  inputCur: 4,
  formulaCur: 5,
  totalCur: 6,
  muted: 7,
  pct: 8,
}

function stylesXml(): string {
  // numFmts: 164 currency "$#,##0", 165 percent "0.0%"
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
<numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0"/>
<numFmt numFmtId="165" formatCode="0.0%"/>
</numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
<font><color rgb="FF1F6FEB"/><sz val="11"/><name val="Calibri"/></font>
<font><color rgb="FF6B7280"/><sz val="10"/><name val="Calibri"/></font>
</fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="165" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`
}

// ─── XML helpers ──────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function colLetter(i: number): string {
  let s = ''
  let n = i
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s
    n = Math.floor(n / 26) - 1
  }
  return s
}

function normaliseCell(c: Cell | string | number | null): Cell {
  if (c === null || c === undefined) return { v: '' }
  if (typeof c === 'string' || typeof c === 'number') return { v: c }
  return c
}

function cellXml(cell: Cell, ref: string): string {
  const s = STYLE_INDEX[cell.style ?? 'default']
  const sAttr = s ? ` s="${s}"` : ''
  if (cell.f !== undefined) {
    // Formula cell — no cached <v>; fullCalcOnLoad forces recompute on open.
    return `<c r="${ref}"${sAttr}><f>${esc(cell.f)}</f></c>`
  }
  const v = cell.v ?? ''
  if (typeof v === 'number' && Number.isFinite(v)) {
    return `<c r="${ref}"${sAttr}><v>${v}</v></c>`
  }
  const text = String(v)
  if (text === '') return `<c r="${ref}"${sAttr}/>`
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`
}

function sheetXml(sheet: Sheet): string {
  const cols = sheet.colWidths
    ? `<cols>${sheet.colWidths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join('')}</cols>`
    : ''

  const rows = sheet.rows
    .map((row, r) => {
      const cells = row
        .map((raw, c) => cellXml(normaliseCell(raw), `${colLetter(c)}${r + 1}`))
        .join('')
      return `<row r="${r + 1}">${cells}</row>`
    })
    .join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows}</sheetData></worksheet>`
}

// ─── ZIP (store method) with CRC32 ────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// Fixed valid DOS datetime (2020-01-01 00:00) — day/month 0 is invalid to strict readers.
const DOS_TIME = 0
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1

interface ZipEntry {
  name: string
  data: Buffer
  crc: number
  offset: number
}

function zipStore(files: Array<{ name: string; content: string | Buffer }>): Buffer {
  const chunks: Buffer[] = []
  const entries: ZipEntry[] = []
  let offset = 0

  for (const f of files) {
    const data = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf-8')
    const nameBuf = Buffer.from(f.name, 'utf-8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18) // compressed
    local.writeUInt32LE(data.length, 22) // uncompressed
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra len

    entries.push({ name: f.name, data, crc, offset })
    chunks.push(local, nameBuf, data)
    offset += local.length + nameBuf.length + data.length
  }

  const central: Buffer[] = []
  let cdSize = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf-8')
    const hdr = Buffer.alloc(46)
    hdr.writeUInt32LE(0x02014b50, 0)
    hdr.writeUInt16LE(20, 4) // version made by
    hdr.writeUInt16LE(20, 6) // version needed
    hdr.writeUInt16LE(0, 8) // flags
    hdr.writeUInt16LE(0, 10) // method
    hdr.writeUInt16LE(DOS_TIME, 12)
    hdr.writeUInt16LE(DOS_DATE, 14)
    hdr.writeUInt32LE(e.crc, 16)
    hdr.writeUInt32LE(e.data.length, 20)
    hdr.writeUInt32LE(e.data.length, 24)
    hdr.writeUInt16LE(nameBuf.length, 28)
    hdr.writeUInt16LE(0, 30) // extra
    hdr.writeUInt16LE(0, 32) // comment
    hdr.writeUInt16LE(0, 34) // disk
    hdr.writeUInt16LE(0, 36) // internal attrs
    hdr.writeUInt32LE(0, 38) // external attrs
    hdr.writeUInt32LE(e.offset, 42)
    central.push(hdr, nameBuf)
    cdSize += hdr.length + nameBuf.length
  }

  const cdOffset = offset
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, ...central, eocd])
}

// ─── Workbook assembly ────────────────────────────────────────────────────────

export function buildXlsx(sheets: Sheet[]): Buffer {
  const sheetFiles = sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(s) }))

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${sheets.map((s, i) => `<sheet name="${esc(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n')}
</sheets>
<calcPr fullCalcOnLoad="1"/>
</workbook>`

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

  return zipStore([
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: rootRels },
    { name: 'xl/workbook.xml', content: workbook },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRels },
    { name: 'xl/styles.xml', content: stylesXml() },
    ...sheetFiles,
  ])
}
