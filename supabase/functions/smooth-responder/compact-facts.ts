export function expandCompactFacts(rows: unknown, documentCount: number) {
  if (!Array.isArray(rows)) throw new Error('Missing compact facts')
  return rows.map((r: unknown) => {
    // Some saved responses omit the short key. Reuse the full fact text as its
    // label without inventing or dropping content; attribution is validated below.
    if (Array.isArray(r) && r.length === 6) r = [r[0], r[1], r[2], r[2], r[3], r[4], r[5]]
    if (!Array.isArray(r) || r.length !== 7) throw new Error('Incomplete compact fact')
    const [source_file_index, category, key, value, page_reference, evidence, rawConfidence] = r
    const parsedConfidence = typeof rawConfidence === 'string' ? (/^\d+(\.\d+)?$/.test(rawConfidence) ? Number(rawConfidence) : ({ high: 80, medium: 50, low: 20 } as Record<string, number>)[rawConfidence.toLowerCase()]) : rawConfidence
    const confidence = typeof parsedConfidence === 'number' && parsedConfidence > 0 && parsedConfidence < 1 ? parsedConfidence * 100 : parsedConfidence
    if (!Number.isInteger(source_file_index) || source_file_index < 0 || source_file_index >= documentCount ||
        ![category,key,value,evidence].every(v => typeof v === 'string' && v.length > 0) ||
        !(page_reference === null || typeof page_reference === 'string') ||
        !Number.isFinite(confidence) || confidence < 0 || confidence > 100) throw new Error('Invalid compact fact attribution or value')
    return { source_file_index, category, key, value, page_reference, evidence, confidence }
  })
}

// An unsupported inference is not a project fact. Quarantine only missing
// evidence; malformed attribution or other fields must still fail closed.
export function separateEvidencedFacts(rows: unknown, documentCount: number) {
  if (!Array.isArray(rows)) throw new Error('Missing compact facts')
  const facts: ReturnType<typeof expandCompactFacts> = []
  const excluded: Array<{ source_file_index: number; row: number; reason: string }> = []
  rows.forEach((original, row) => {
    const r = Array.isArray(original) && original.length === 6
      ? [original[0], original[1], original[2], original[2], original[3], original[4], original[5]]
      : original
    if (Array.isArray(r) && r.length === 7 && (r[5] === null || (typeof r[5] === 'string' && !r[5].trim()))) {
      const checked = expandCompactFacts([[...r.slice(0, 5), 'validation only', r[6]]], documentCount)[0]
      excluded.push({ source_file_index: checked.source_file_index, row, reason: 'No source evidence; excluded from project facts' })
    } else facts.push(...expandCompactFacts([r], documentCount))
  })
  if (excluded.length && !facts.length) throw new Error('No evidenced facts in document analysis')
  return { facts, excluded }
}

// Dense text schedules can demand long row-by-row output despite tiny PDF bytes.
export function hasDenseText(block: unknown): boolean {
  const blocks = Array.isArray(block) ? block : [block]
  const chars = blocks.reduce((n: number, b: any) => n + (b?.type === 'text' && typeof b.text === 'string' ? b.text.length : 0), 0)
  return chars >= 16000
}
