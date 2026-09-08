export function expandCompactFacts(rows: unknown, documentCount: number) {
  if (!Array.isArray(rows)) throw new Error('Missing compact facts')
  return rows.map((r: unknown) => {
    if (!Array.isArray(r) || r.length !== 7) throw new Error('Incomplete compact fact')
    const [source_file_index, category, key, value, page_reference, evidence, rawConfidence] = r
    const confidence = typeof rawConfidence === 'string' ? ({ high: 80, medium: 50, low: 20 } as Record<string, number>)[rawConfidence.toLowerCase()] : rawConfidence
    if (!Number.isInteger(source_file_index) || source_file_index < 0 || source_file_index >= documentCount ||
        ![category,key,value,evidence].every(v => typeof v === 'string' && v.length > 0) ||
        !(page_reference === null || typeof page_reference === 'string') ||
        !Number.isInteger(confidence) || confidence < 0 || confidence > 100) throw new Error('Invalid compact fact attribution or value')
    return { source_file_index, category, key, value, page_reference, evidence, confidence }
  })
}

// Dense text schedules can demand long row-by-row output despite tiny PDF bytes.
export function hasDenseText(block: unknown): boolean {
  const blocks = Array.isArray(block) ? block : [block]
  const chars = blocks.reduce((n: number, b: any) => n + (b?.type === 'text' && typeof b.text === 'string' ? b.text.length : 0), 0)
  return chars >= 16000
}
